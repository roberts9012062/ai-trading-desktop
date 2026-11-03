//! Separate native Go worker. Secrets only cross its private stdin pipe.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
};
use zeroize::{Zeroize, Zeroizing};

const PROTOCOL: &str = "taskhost-go-worker-v1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    url: String,
    sha256: String,
    size: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    protocol: String,
    platforms: BTreeMap<String, Artifact>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Exchange {
    api_key: String,
    secret: String,
    passphrase: String,
    demo: bool,
}
impl Drop for Exchange {
    fn drop(&mut self) {
        self.api_key.zeroize();
        self.secret.zeroize();
        self.passphrase.zeroize();
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    id: String,
    name: String,
    kind: String,
    base_url: String,
    model_id: String,
    api_key: String,
}
impl Drop for Model {
    fn drop(&mut self) {
        self.api_key.zeroize();
        self.base_url.zeroize();
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    exchange: Exchange,
    models: Vec<Model>,
}
#[derive(Serialize)]
struct Bootstrap<'a> {
    protocol: &'static str,
    center_key: &'a str,
    exchange: &'a Exchange,
    models: &'a [Model],
    account_id: &'a str,
    database_path: &'a Path,
    mode: &'static str,
    allow_trading: bool,
}
#[derive(Clone, Serialize)]
struct Status {
    protocol: &'static str,
    state: String,
    event: String,
    account_id: String,
    checkpoint_seq: String,
    error_code: String,
    data_source: String,
    data_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_observed_at: Option<String>,
    data_stale: bool,
}
impl Status {
    fn initial(account: &str) -> Self {
        Self {
            protocol: PROTOCOL,
            state: "starting".into(),
            event: "status".into(),
            account_id: account.into(),
            checkpoint_seq: "0".into(),
            error_code: String::new(),
            data_source: "none".into(),
            data_code: String::new(),
            data_observed_at: None,
            data_stale: true,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    protocol: String,
    event: String,
    state: String,
    account_id: Option<String>,
    checkpoint_seq: Option<String>,
    error_code: Option<String>,
    data_source: Option<String>,
    data_code: Option<String>,
    data_observed_at: Option<String>,
    data_stale: Option<bool>,
}
#[derive(Clone,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct CommandReply {
    protocol:String,event:String,state:String,account_id:String,request_id:String,
    error_code:Option<String>,epoch:Option<String>,
}
fn command_reply(line:&str,account:&str)->Result<Option<CommandReply>,String>{
    let value:Value=serde_json::from_str(line).map_err(|_|"worker_protocol_invalid")?;
    if value["event"]!="command"{return Ok(None);}
    let reply:CommandReply=serde_json::from_value(value).map_err(|_|"worker_protocol_invalid")?;
    if reply.protocol!=PROTOCOL||reply.event!="command"||reply.account_id!=account
        ||reply.request_id.len()!=32||!reply.request_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
        ||!["delete_ready","recovery_confirmed","preparing","blocked"].contains(&reply.state.as_str())
        ||(reply.state=="blocked"&&reply.error_code.as_deref()!=Some("command_blocked"))
        ||(reply.state!="blocked"&&reply.error_code.as_ref().is_some_and(|c|!c.is_empty()))
        ||(reply.state=="delete_ready"&&!reply.epoch.as_deref().is_some_and(|v|counter(v)&&v!="0"))
        ||(reply.state!="delete_ready"&&reply.epoch.is_some()) {return Err("worker_protocol_invalid".into());}
    Ok(Some(reply))
}
struct Running {
    child: Child,
    input: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    reader: Option<tokio::task::JoinHandle<()>>,
    status: Arc<Mutex<Status>>,
    scope: String,
    account: String,
    stopping: bool,
    command:Arc<Mutex<Option<CommandReply>>>,
}
#[derive(Default)]
pub struct GoWorkerState {
    running: tokio::sync::Mutex<Option<Running>>,
    generation: AtomicU64,
    quitting: AtomicBool,
}
impl GoWorkerState {
    fn invalidate(&self) {
        if self
            .generation
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                n.checked_add(1).filter(|n| *n <= i64::MAX as u64)
            })
            .is_err()
        {
            self.quitting.store(true, Ordering::SeqCst);
        }
    }
    fn can_start(&self, expected: Option<&str>) -> Result<(), String> {
        if self.quitting.load(Ordering::SeqCst)
            || expected != Some(self.generation.load(Ordering::SeqCst).to_string().as_str())
        {
            return Err("执行器上下文已变化，请刷新后明确启动；退出或升级期间不能启动".into());
        }
        Ok(())
    }
}

fn hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn counter(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 19
        && (v == "0" || !v.starts_with('0'))
        && v.bytes().all(|b| b.is_ascii_digit())
        && v.parse::<u64>().is_ok_and(|n| n <= i64::MAX as u64)
}
fn uuid(v: &str) -> bool {
    v.len() == 36
        && v.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn validate(input: &Input) -> Result<(), String> {
    let e = &input.exchange;
    if [e.api_key.len(), e.secret.len(), e.passphrase.len()]
        .iter()
        .any(|n| *n < 1 || *n > 256)
        || input.models.len() > 50
    {
        return Err("执行器凭证格式无效".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for m in &input.models {
        let url = reqwest::Url::parse(&m.base_url).map_err(|_| "模型地址无效")?;
        if !uuid(&m.id)
            || !ids.insert(&m.id)
            || m.name.is_empty()
            || m.name.len() > 480
            || !["openai", "claude", "jev"].contains(&m.kind.as_str())
            || m.model_id.is_empty()
            || m.model_id.len() > 256
            || m.api_key.len() < 8
            || m.api_key.len() > 8192
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("模型配置格式无效".into());
        }
    }
    Ok(())
}
fn paths(app: &tauri::AppHandle, scope: &str, account: &str) -> Result<(PathBuf, PathBuf), String> {
    if !hash(account) || !scope.starts_with("taskhost:standalone:") || scope.len() > 200 {
        return Err("请先完成单机账户登录".into());
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, scope.as_bytes());
    let label: String = digest.as_ref().iter().map(|v| format!("{v:02x}")).collect();
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "本机配置目录不可用")?
        .join("taskhost-go")
        .join(label)
        .join(account);
    Ok((dir.join("inputs.bin"), dir.join("vault.db")))
}
fn verified(root: &Path) -> Result<PathBuf, String> {
    let pin: Pin = serde_json::from_str(include_str!("../../taskhost-go-worker.lock.json"))
        .map_err(|_| "Go 执行器固定版本无效")?;
    #[cfg(windows)]
    let (platform, name) = ("windows-x86_64", "taskhost-go-worker.exe");
    #[cfg(not(windows))]
    let (platform, name) = ("linux-x86_64", "taskhost-go-worker");
    let p = pin
        .platforms
        .get(platform)
        .ok_or("此版本尚未包含已验证 Go 执行器")?;
    if pin.protocol != PROTOCOL
        || !hash(&p.sha256)
        || p.size == 0
        || p.size > 100 * 1024 * 1024
        || !p.url.starts_with("https://github.com/")
    {
        return Err("Go 执行器固定版本无效".into());
    }
    let file = root.join(name);
    let meta = std::fs::symlink_metadata(&file).map_err(|_| "请安装包含 Go 执行器的完整版本")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != p.size {
        return Err("Go 执行器完整性检查失败".into());
    }
    let bytes = std::fs::read(&file).map_err(|_| "Go 执行器不可读取")?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &bytes);
    let actual: String = digest.as_ref().iter().map(|v| format!("{v:02x}")).collect();
    if actual != p.sha256 {
        return Err("Go 执行器完整性检查失败".into());
    }
    Ok(file)
}
fn artifact_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/taskhost-go-worker");
        if local.is_dir() {
            return Ok(local);
        }
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|_| "资源目录不可用")?
        .join("taskhost-go-worker"))
}
fn apply_event(status: &mut Status, line: &str) -> Result<(), String> {
    if line.len() > 4096 {
        return Err("worker_protocol_invalid".into());
    }
    let v: Event = serde_json::from_str(line).map_err(|_| "worker_protocol_invalid")?;
    let has_data = v.data_source.is_some() || v.data_code.is_some() || v.data_observed_at.is_some() || v.data_stale.is_some();
    if v.protocol != PROTOCOL
        || !["ready", "status", "stopped", "failed"].contains(&v.event.as_str())
        || (v.event == "stopped" && v.state != "stopped")
        || (v.event == "failed" && v.state != "failed")
        || ![
            "starting",
            "observing",
            "waiting_owner",
            "reconciling",
            "running",
            "paused",
            "stopped",
            "blocked",
            "failed",
        ]
        .contains(&v.state.as_str())
        || v.account_id
            .as_ref()
            .is_some_and(|id| id != &status.account_id)
        || v.checkpoint_seq.as_ref().is_some_and(|n| !counter(n))
        || (has_data && v.event != "status")
        || v.data_source.as_ref().is_some_and(|value| !["direct", "collection", "none"].contains(&value.as_str()))
        || v.data_code.as_ref().is_some_and(|value| !value.is_empty() && ![
            "okx_direct_unavailable", "reader_closed", "read_not_allowed", "data_unavailable",
            "authentication_failed", "identity_changed", "invalid_response", "request_rejected",
            "data_settings_unavailable", "data_configuration_invalid",
        ].contains(&value.as_str()))
        || v.data_observed_at.as_ref().is_some_and(|value| value.len() > 40 || time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_err())
        || v.error_code.as_ref().is_some_and(|c| {
            !c.is_empty()
                && ![
                    "bootstrap_invalid",
                    "center_unavailable",
                    "identity_changed",
                    "database_unavailable",
                    "existing_tasks_unavailable",
                    "runtime_blocked",
                    "shutdown_incomplete",
                    "internal_error",
                ]
                .contains(&c.as_str())
        })
    {
        return Err("worker_protocol_invalid".into());
    }
    status.event = v.event;
    status.state = v.state;
    status.checkpoint_seq = v
        .checkpoint_seq
        .unwrap_or_else(|| status.checkpoint_seq.clone());
    status.error_code = v.error_code.unwrap_or_default();
    status.data_source = v.data_source.unwrap_or_else(|| "none".into());
    status.data_code = v.data_code.unwrap_or_default();
    status.data_observed_at = v.data_observed_at;
    let recent_data = status.data_observed_at.as_ref().and_then(|value| time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()).is_some_and(|observed| {
        let age = time::OffsetDateTime::now_utc() - observed;
        observed.year() >= 2000 && age >= time::Duration::seconds(-10) && age <= time::Duration::seconds(60)
    });
    status.data_stale = v.data_stale.unwrap_or(true)
        || status.event != "status"
        || !recent_data
        || (!status.data_code.is_empty() && status.data_code != "okx_direct_unavailable")
        || !["direct", "collection"].contains(&status.data_source.as_str());
    Ok(())
}
async fn stop(r: &mut Running) -> Result<Value, String> {
    if !r.stopping {
        r.stopping = true;
        signal_stop(&r.input).await;
    }
    let exit = tokio::time::timeout(Duration::from_secs(90), r.child.wait())
        .await
        .map_err(|_| "Go 执行器尚未确认退出；保留核对状态，不能启动另一个执行器")?
        .map_err(|_| "Go 执行器退出结果未知")?;
    if let Some(reader) = r.reader.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
    let status = r.status.lock().map_err(|_| "执行器状态不可用")?;
    if !exit.success() || status.event != "stopped" || status.state != "stopped" {
        return Err("Go 执行器退出未完成检查点确认，请到中心核对".into());
    }
    Ok(json!({"exited":true,"shutdown_acknowledged":true,"execution_authority":false}))
}
async fn signal_stop(pipe: &Arc<tokio::sync::Mutex<Option<ChildStdin>>>) {
    if let Some(mut input) = pipe.lock().await.take() {
        let _ = input
            .write_all(b"{\"protocol\":\"taskhost-go-worker-v1\",\"command\":\"stop\"}\n")
            .await;
        let _ = input.flush().await;
        let _ = input.shutdown().await;
    }
}
async fn maintenance(r:&mut Running,state:&GoWorkerState,action:&str,expected:Option<&str>)->Result<Value,String>{
    state.can_start(expected)?;
    if r.stopping{return Err("执行器正在退出，请先核对停止状态".into());}
    let generation=state.generation.load(Ordering::SeqCst);
    let mut bytes=[0u8;16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(),&mut bytes).map_err(|_|"无法生成操作标识")?;
    let id:String=bytes.iter().map(|b|format!("{b:02x}")).collect();
    *r.command.lock().map_err(|_|"执行器回复不可用")?=None;
    let mut raw=serde_json::to_vec(&json!({"protocol":PROTOCOL,"command":action,"request_id":id})).map_err(|_|"执行器命令无效")?;raw.push(b'\n');
    {let mut pipe=r.input.lock().await;let input=pipe.as_mut().ok_or("执行器正在退出")?;input.write_all(&raw).await.map_err(|_|"执行器命令结果未确认")?;input.flush().await.map_err(|_|"执行器命令结果未确认")?;}
    let deadline=tokio::time::Instant::now()+Duration::from_secs(110);
    loop{
        if state.quitting.load(Ordering::SeqCst)||state.generation.load(Ordering::SeqCst)!=generation{signal_stop(&r.input).await;return Err("执行器上下文已变化，操作结果请重新核对".into());}
        let reply=r.command.lock().map_err(|_|"执行器回复不可用")?.clone();
        if let Some(reply)=reply.filter(|reply|reply.request_id==id){
            if reply.state=="blocked"{return Err("准备未确认，请核对任务已暂停、真实空仓、全部挂单和未决交易".into());}
            return Ok(json!({"state":reply.state,"epoch":reply.epoch,"refresh_required":true,"execution_authority":false}));
        }
        if r.child.try_wait().map_err(|_|"执行器退出状态未确认")?.is_some()||tokio::time::Instant::now()>=deadline{return Err("准备结果未确认，请刷新核对；不会自动重试".into());}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn launch(
    mut command: Command,
    raw: &[u8],
    scope: String,
    account: String,
) -> Result<Running, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Go 执行器启动失败")?;
    let mut stdin = child.stdin.take().ok_or("执行器输入管道不可用")?;
    stdin
        .write_all(raw)
        .await
        .map_err(|_| "执行器初始化未确认")?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| "执行器初始化未确认")?;
    stdin.flush().await.map_err(|_| "执行器初始化未确认")?;
    let pipe = Arc::new(tokio::sync::Mutex::new(Some(stdin)));
    let stop_pipe = pipe.clone();
    let stdout = child.stdout.take().ok_or("执行器状态管道不可用")?;
    let status = Arc::new(Mutex::new(Status::initial(&account)));
    let observed = status.clone();
    let command_reply_slot=Arc::new(Mutex::new(None));
    let reply_slot=command_reply_slot.clone();
    let expected_account=account.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout);
        loop {
            let mut raw = Vec::new();
            let count = (&mut lines).take(4097).read_until(b'\n', &mut raw).await;
            if matches!(count, Ok(0)) {
                break;
            }
            let result = std::str::from_utf8(&raw)
                .ok()
                .and_then(|s| {
                    match command_reply(s,&expected_account){
                        Ok(Some(reply))=>return reply_slot.lock().ok().map(|mut slot|{*slot=Some(reply);true}),
                        Err(_)=>return Some(false),
                        Ok(None)=>{},
                    }
                    observed
                        .lock()
                        .ok()
                        .map(|mut v| apply_event(&mut v, s).is_ok())
                })
                .unwrap_or(false);
            if count.is_err() || !result {
                if let Ok(mut v) = observed.lock() {
                    v.state = "failed".into();
                    v.event = "failed".into();
                    v.error_code = "worker_protocol_invalid".into();
                }
                signal_stop(&stop_pipe).await;
                break;
            }
        }
    });
    Ok(Running {
        child,
        input: pipe,
        reader: Some(reader),
        status,
        scope,
        account,
        stopping: false,
        command:command_reply_slot,
    })
}
pub async fn shutdown(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GoWorkerState>();
    state.quitting.store(true, Ordering::SeqCst);
    state.invalidate();
    let mut guard = state.running.lock().await;
    if let Some(r) = guard.as_mut() {
        stop(r).await?;
    }
    *guard = None;
    Ok(())
}
pub fn allow_resume_after_failed_update(app: &tauri::AppHandle) {
    let state = app.state::<GoWorkerState>();
    state.invalidate();
    state.quitting.store(false, Ordering::SeqCst);
}
#[tauri::command]
pub async fn taskhost_go_shutdown(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GoWorkerState>();
    state.invalidate();
    let mut guard = state.running.lock().await;
    if let Some(r) = guard.as_mut() {
        stop(r).await?;
    }
    *guard = None;
    Ok(())
}
pub async fn stop_scope(app: &tauri::AppHandle, scope: &str) -> Result<(), String> {
    let state = app.state::<GoWorkerState>();
    state.invalidate();
    let mut guard = state.running.lock().await;
    if let Some(r) = guard.as_mut() {
        if r.scope != scope {
            return Ok(());
        }
        stop(r).await?;
    }
    *guard = None;
    Ok(())
}
#[tauri::command]
pub async fn taskhost_go_worker(
    app: tauri::AppHandle,
    state: tauri::State<'_, GoWorkerState>,
    scope: String,
    account_id: String,
    action: String,
    input: Option<Input>,
    allow_trading: Option<bool>,
    expected_generation: Option<String>,
) -> Result<Value, String> {
    let (sealed, database) = paths(&app, &scope, &account_id)?;
    if action == "stop" || action == "save" {
        state.invalidate();
    }
    if action == "start" {
        state.can_start(expected_generation.as_deref())?;
    }
    if action == "status" && state.running.try_lock().is_err() {
        return Ok(
            json!({"installed":verified(&artifact_root(&app)?).is_ok(),"configured":sealed.is_file(),"exited":false,"busy":true,"generation":state.generation.load(Ordering::SeqCst).to_string(),"execution_authority":false}),
        );
    }
    let mut guard = state.running.lock().await;
    match action.as_str() {
        "save" => {
            if guard.is_some() {
                return Err("请先停止并确认执行器退出，再修改凭证".into());
            }
            let input = input.ok_or("请填写执行器凭证")?;
            validate(&input)?;
            let raw = Zeroizing::new(serde_json::to_vec(&input).map_err(|_| "执行器配置无效")?);
            let entropy = format!("{scope}:{account_id}:taskhost-go-v1");
            let data = crate::market_data::protect(&raw, entropy.as_bytes(), true)?;
            std::fs::create_dir_all(sealed.parent().ok_or("执行器路径无效")?)
                .map_err(|_| "无法创建执行器配置目录")?;
            let temp = sealed.with_extension("tmp");
            std::fs::write(&temp, data).map_err(|_| "无法保存加密执行器配置")?;
            std::fs::rename(temp, sealed).map_err(|_| "无法保存加密执行器配置")?;
            Ok(json!({"configured":true,"execution_authority":false}))
        }
        "status" => {
            let installed = verified(&artifact_root(&app)?).is_ok();
            if let Some(r) = guard.as_mut() {
                if r.scope != scope || r.account != account_id {
                    return Ok(
                        json!({"installed":installed,"configured":sealed.is_file(),"active_elsewhere":true,"generation":state.generation.load(Ordering::SeqCst).to_string(),"execution_authority":false}),
                    );
                }
                let exited = r
                    .child
                    .try_wait()
                    .map_err(|_| "执行器状态未确认")?
                    .is_some();
                let status = r.status.lock().map_err(|_| "执行器状态不可用")?.clone();
                return Ok(
                    json!({"installed":installed,"configured":sealed.is_file(),"exited":exited,"active":true,"status":status,"generation":state.generation.load(Ordering::SeqCst).to_string(),"execution_authority":false}),
                );
            }
            Ok(
                json!({"installed":installed,"configured":sealed.is_file(),"exited":true,"active":false,"generation":state.generation.load(Ordering::SeqCst).to_string(),"execution_authority":false}),
            )
        }
        "stop" => {
            let Some(r) = guard.as_mut() else {
                return Ok(json!({"exited":true,"execution_authority":false}));
            };
            if r.scope != scope || r.account != account_id {
                return Err("请在原单机账户停止执行器".into());
            }
            let result = stop(r).await;
            if r.child.try_wait().ok().flatten().is_some() {
                *guard = None;
            }
            result
        }
        "prepare-delete"|"prepare-resume"|"confirm-flat"=>{
            let r=guard.as_mut().ok_or("请先启动本机 Go 观察进程")?;
            if r.scope!=scope||r.account!=account_id{return Err("请在原本机交易账户操作".into());}
            maintenance(r,&state,&action,expected_generation.as_deref()).await
        }
        "start" => {
            state.can_start(expected_generation.as_deref())?;
            if guard.is_some() {
                return Err("已有执行器或退出未确认，请先停止并核对".into());
            }
            let exe = verified(&artifact_root(&app)?)?;
            let center = crate::market_data::read_key(&app, &scope)?;
            let bytes = std::fs::read(&sealed).map_err(|_| "请先加密保存执行器凭证")?;
            let entropy = format!("{scope}:{account_id}:taskhost-go-v1");
            let plain = Zeroizing::new(crate::market_data::protect(
                &bytes,
                entropy.as_bytes(),
                false,
            )?);
            let input: Input =
                serde_json::from_slice(&plain).map_err(|_| "执行器配置损坏，请重新保存")?;
            validate(&input)?;
            let raw = Zeroizing::new(
                serde_json::to_vec(&Bootstrap {
                    protocol: PROTOCOL,
                    center_key: center.as_str(),
                    exchange: &input.exchange,
                    models: &input.models,
                    account_id: &account_id,
                    database_path: &database,
                    mode: "standalone",
                    allow_trading: allow_trading.unwrap_or(false),
                })
                .map_err(|_| "执行器配置无效")?,
            );
            let mut command = Command::new(exe);
            command.env_clear();
            *guard = Some(launch(command, &raw, scope, account_id).await?);
            Ok(json!({"started":true,"execution_authority":false}))
        }
        _ => Err("不支持的 Go 执行器操作".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires the exact downloaded public Go worker pin"]
    async fn compiled_go_distribution_rejects_bootstrap_without_network_and_matches_pin(){
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/taskhost-go-worker");
        let binary=verified(&root).expect("candidate must match its pinned digest");
        let mut command=Command::new(binary);command.env_clear();
        let mut running=launch(command,b"{\"protocol\":\"taskhost-go-worker-v1\",\"center_key\":\"synthetic-private-only\",\"owner_id\":\"untrusted\"}","compiled-fixture".into(),"a".repeat(64)).await.unwrap();
        let exit=tokio::time::timeout(Duration::from_secs(15),running.child.wait()).await.unwrap().unwrap();
        if let Some(reader)=running.reader.take(){reader.await.unwrap();}
        let status=running.status.lock().unwrap();
        assert!(!exit.success());assert_eq!(status.event,"failed");assert_eq!(status.state,"failed");assert_eq!(status.error_code,"bootstrap_invalid");
        assert!(!serde_json::to_string(&*status).unwrap().contains("synthetic-private"));
    }
    #[test]
    fn maintenance_receipts_cannot_be_stop_receipts_or_foreign_evidence(){
        let account="a".repeat(64);
        let good=json!({"protocol":PROTOCOL,"event":"command","state":"delete_ready","account_id":account,"request_id":"b".repeat(32),"epoch":"9007199254740993"});
        assert!(command_reply(&good.to_string(),&account).unwrap().is_some());
        let mut status=Status::initial(&account);
        assert!(apply_event(&mut status,&good.to_string()).is_err());
        for (field,value) in [("account_id",json!("c".repeat(64))),("epoch",json!(9007199254740993u64)),("state",json!("stopped")),("error_code",json!("private-secret")),("request_id",json!("chosen"))]{
            let mut bad=good.clone();bad[field]=value;assert!(command_reply(&bad.to_string(),&account).is_err());
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn isolated_maintenance_is_correlated_and_does_not_stop_the_worker(){
        let directory=std::env::temp_dir().join(format!("taskhost-maintenance-{}-{}",std::process::id(),time::OffsetDateTime::now_utc().unix_timestamp_nanos()));
        std::fs::create_dir(&directory).unwrap();
        let script=directory.join("fixture.ps1");
        let account="a".repeat(64);
        let content=format!("$null=[Console]::ReadLine()\n$command=[Console]::ReadLine()|ConvertFrom-Json\nif($command.command -ne 'prepare-delete'){{exit 9}}\n[Console]::WriteLine((@{{protocol='{PROTOCOL}';event='command';state='delete_ready';account_id='{account}';request_id=$command.request_id;epoch='5'}}|ConvertTo-Json -Compress))\n$stop=[Console]::ReadLine()|ConvertFrom-Json\nif($stop.command -ne 'stop'){{exit 8}}\n[Console]::WriteLine('{{\"protocol\":\"{PROTOCOL}\",\"event\":\"stopped\",\"state\":\"stopped\"}}')\n");
        std::fs::write(&script,content).unwrap();
        let mut command=Command::new("powershell.exe");command.args(["-NoProfile","-NonInteractive","-File"]).arg(&script);
        let mut running=launch(command,b"{\"synthetic_fixture\":true}","fixture".into(),account).await.unwrap();
        let state=GoWorkerState::default();
        let result=maintenance(&mut running,&state,"prepare-delete",Some("0")).await.unwrap();
        assert_eq!(result["state"],"delete_ready");assert_eq!(result["execution_authority"],false);assert!(running.child.try_wait().unwrap().is_none());
        assert!(stop(&mut running).await.is_ok());
        std::fs::remove_file(&script).unwrap();std::fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn fixed_events_never_reflect_untrusted_errors() {
        let mut status = Status::initial(&"a".repeat(64));
        for raw in [
            r#"{"protocol":"taskhost-go-worker-v1","event":"failed","state":"failed","error_code":"secret-user-input"}"#,
            r#"{"protocol":"taskhost-go-worker-v1","event":"ready","state":"running","secret":"hidden"}"#,
        ] {
            assert!(apply_event(&mut status, raw).is_err());
            assert!(!serde_json::to_string(&status).unwrap().contains("secret"));
        }
        assert!(apply_event(&mut status,r#"{"protocol":"taskhost-go-worker-v1","event":"ready","state":"observing","checkpoint_seq":"0"}"#).is_ok());
    }
    #[test]
    fn data_telemetry_is_whitelisted_status_only_and_never_a_stop_receipt() {
        let account = "a".repeat(64);
        let mut status = Status::initial(&account);
        let observed = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap();
        let event = json!({"protocol":PROTOCOL,"event":"status","state":"running","data_source":"collection","data_code":"okx_direct_unavailable","data_observed_at":observed,"data_stale":false});
        assert!(apply_event(&mut status,&event.to_string()).is_ok());
        assert_eq!(status.data_source,"collection");assert!(!status.data_stale);assert_eq!(status.event,"status");
        let mut authentication=event.clone();authentication["data_code"]=json!("authentication_failed");
        apply_event(&mut status,&authentication.to_string()).unwrap();assert!(status.data_stale);
        for (field,value) in [("data_code",json!("synthetic-private-response")),("data_source",json!("https://private.invalid")),("event",json!("stopped")),("data_stale",json!("false"))] {
            let mut malformed=event.clone();malformed[field]=value;
            if field=="event"{malformed["state"]=json!("stopped");}
            assert!(apply_event(&mut status,&malformed.to_string()).is_err());
            assert!(!serde_json::to_string(&status).unwrap().contains("synthetic-private"));
        }
        let legacy=json!({"protocol":PROTOCOL,"event":"status","state":"observing"});
        apply_event(&mut status,&legacy.to_string()).unwrap();assert!(status.data_stale);assert_eq!(status.data_source,"none");assert!(status.data_observed_at.is_none());
    }
    #[test]
    fn exact_counters_and_input_boundaries() {
        assert!(counter("9223372036854775807"));
        for v in ["01", "-1", "9223372036854775808", "1e3"] {
            assert!(!counter(v));
        }
        let invalid = Input {
            exchange: Exchange {
                api_key: "fixture".into(),
                secret: "fixture".into(),
                passphrase: "fixture".into(),
                demo: true,
            },
            models: vec![Model {
                id: "bad".into(),
                name: "fixture".into(),
                kind: "openai".into(),
                base_url: "http://localhost".into(),
                model_id: "fixture".into(),
                api_key: "fixture".into(),
            }],
        };
        assert!(validate(&invalid).is_err());
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn isolated_pipe_shutdown_requires_stopped_event_and_actual_exit() {
        let directory = std::env::temp_dir().join(format!(
            "taskhost-go-fixture-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        for (name,last,expected) in [("ack","{\"protocol\":\"taskhost-go-worker-v1\",\"event\":\"stopped\",\"state\":\"stopped\"}",true),("missing","{\"protocol\":\"taskhost-go-worker-v1\",\"event\":\"status\",\"state\":\"blocked\"}",false)]{
            let script=directory.join(format!("{name}.ps1"));
            let content=format!("$null=[Console]::ReadLine()\n[Console]::WriteLine('{{\"protocol\":\"taskhost-go-worker-v1\",\"event\":\"ready\",\"state\":\"observing\"}}')\n$stop=[Console]::ReadLine()\nif(($stop|ConvertFrom-Json).command -ne 'stop'){{exit 9}}\n[Console]::WriteLine('{last}')\n");
            std::fs::write(&script,content).unwrap();
            let mut command=Command::new("powershell.exe");command.args(["-NoProfile","-NonInteractive","-File"]).arg(&script);
            let mut running=launch(command,b"{\"synthetic_fixture\":true}","fixture".into(),"a".repeat(64)).await.unwrap();
            assert_eq!(stop(&mut running).await.is_ok(),expected);
            assert!(running.child.try_wait().unwrap().is_some());
            std::fs::remove_file(&script).unwrap();
        }
        std::fs::remove_dir(directory).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_inputs_roundtrip_and_reject_other_account_entropy() {
        let raw = Zeroizing::new(b"synthetic-secret-never-log".to_vec());
        let encrypted = crate::market_data::protect(&raw, b"fixture-account-one", true).unwrap();
        assert_ne!(&encrypted, &*raw);
        let recovered = Zeroizing::new(
            crate::market_data::protect(&encrypted, b"fixture-account-one", false).unwrap(),
        );
        assert_eq!(&*recovered, &*raw);
        assert!(crate::market_data::protect(&encrypted, b"fixture-account-two", false).is_err());
    }
    #[tokio::test]
    async fn queued_start_is_fenced_by_stop_and_terminal_shutdown() {
        let state = Arc::new(GoWorkerState::default());
        let guard = state.running.lock().await;
        let waiting = state.clone();
        let (ready, received) = tokio::sync::oneshot::channel();
        let start = tokio::spawn(async move {
            waiting.can_start(Some("0"))?;
            let _ = ready.send(());
            let _guard = waiting.running.lock().await;
            waiting.can_start(Some("0"))
        });
        received.await.unwrap();
        state.invalidate();
        drop(guard);
        assert!(start.await.unwrap().is_err());
        assert!(state.can_start(Some("1")).is_ok());
        state.quitting.store(true, Ordering::SeqCst);
        state.invalidate();
        assert!(state.can_start(Some("2")).is_err());
    }
    #[test]
    fn bootstrap_has_no_client_authority_identity_and_pipes_only_secrets() {
        let exchange = Exchange {
            api_key: "fixture-api-key".into(),
            secret: "fixture-secret".into(),
            passphrase: "fixture-passphrase".into(),
            demo: true,
        };
        let raw = Zeroizing::new(
            serde_json::to_vec(&Bootstrap {
                protocol: PROTOCOL,
                center_key: "ac_fixture",
                exchange: &exchange,
                models: &[],
                account_id: &"a".repeat(64),
                database_path: Path::new("C:/synthetic/vault.db"),
                mode: "standalone",
                allow_trading: false,
            })
            .unwrap(),
        );
        let value: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(value["allow_trading"], false);
        assert_eq!(value["mode"], "standalone");
        for key in [
            "owner_id",
            "subject",
            "center_user_id",
            "tasks",
            "ready",
            "flat",
        ] {
            assert!(value.get(key).is_none());
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn malformed_stdout_triggers_stop_without_reflecting_worker_secrets() {
        let directory = std::env::temp_dir().join(format!(
            "taskhost-go-invalid-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("fixture.ps1");
        std::fs::write(&script,"$null=[Console]::ReadLine()\n[Console]::WriteLine('synthetic-secret-invalid-output')\n$stop=[Console]::ReadLine()\nif(($stop|ConvertFrom-Json).command -ne 'stop'){exit 9}\nexit 1\n").unwrap();
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(&script);
        let mut running = launch(
            command,
            b"{\"synthetic_fixture\":true}",
            "fixture".into(),
            "a".repeat(64),
        )
        .await
        .unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(5), running.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!exit.success());
        let snapshot = serde_json::to_string(&*running.status.lock().unwrap()).unwrap();
        assert!(snapshot.contains("worker_protocol_invalid"));
        assert!(!snapshot.contains("synthetic-secret"));
        std::fs::remove_file(script).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}

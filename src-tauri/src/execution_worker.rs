//! Private compiled account worker. No executable path or secret is accepted from IPC.
use ring::digest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, io::Read, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, sync::mpsc};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
pub(crate) const PROTOCOL: u32 = 1;

#[derive(Clone, Serialize)]
pub(crate) struct WorkerStatus {
    pub account_id: String,
    pub state: String,
    pub error: String,
    #[serde(skip)]
    stop_receipt: bool,
    #[serde(skip)]
    last_status:std::time::Instant,
}
impl WorkerStatus {
    fn new(account: &str) -> Self {
        Self { account_id:account.into(), state:"preparing".into(), error:String::new(), stop_receipt:false,last_status:std::time::Instant::now() }
    }
    fn accept(&mut self, raw: &[u8]) -> Result<()> {
        if raw.len()>8192 { return Err("InvalidWorkerStatus".into()); }
        // Library startup output is discarded; never forward a raw line/error.
        let Ok(value) = serde_json::from_slice::<Value>(raw) else { return Ok(()); };
        if value["type"]!="executor-status" || value["role"]!="desktop" || value["account_id"]!=self.account_id { return Ok(()); }
        let state=value["state"].as_str().unwrap_or("");
        if !["preparing","running","stopped","waiting_executor","waiting_reconciliation","manual_flatten_required","server_sync_required","startup_failed"].contains(&state) {
            return Err("InvalidWorkerStatus".into());
        }
        self.stop_receipt=state=="stopped";
        self.last_status=std::time::Instant::now();
        self.state=if self.stop_receipt { "stopping" } else { state }.into();
        if let Some(error)=value["error"].as_str().filter(|e|e.len()<=64 && e.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_')) {self.error=error.into();}
        Ok(())
    }
    fn exited(&mut self, success:bool, invalid:bool) {
        if success && !invalid && self.stop_receipt {
            self.state="stopped".into(); self.error.clear();
        } else if self.state!="manual_flatten_required" {
            self.state="waiting_reconciliation".into();
            if self.error.is_empty() {self.error="CheckpointUnconfirmed".into();}
        }
    }
}

fn artifact_path(root:&Path, raw:&str) -> Result<PathBuf> {
    let name=raw.to_ascii_lowercase();
    if raw.is_empty() || raw.len()>512 || raw.contains(['\\',':']) || raw.chars().any(char::is_control)
        || raw.split('/').any(|p|p.is_empty() || p=="." || p==".." || p.ends_with(['.',' ']))
        || [".py",".pyc",".pyo",".pyw"].iter().any(|s|name.ends_with(s))
        || name.split('/').any(|p|p==".env" || p.starts_with(".env.")) {
        return Err("执行器构建清单包含不安全文件".into());
    }
    Ok(root.join(raw))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactFile { path:String, sha256:String, size:u64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactManifest { protocol:u32, entry:String, build_id:String, files:Vec<ArtifactFile> }

#[derive(Deserialize)]
struct ArtifactPin { protocol:u32, build_id:String, manifest_sha256:String }

fn regular(path:&Path, directory:bool) -> Result<()> {
    let meta=std::fs::symlink_metadata(path).map_err(|_|"执行器文件缺失")?;
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {return Err("执行器目录不能包含重解析点".into());}
    }
    if meta.file_type().is_symlink() || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {return Err("执行器文件类型无效".into());}
    Ok(())
}
fn actual_files(root:&Path, directory:&Path, found:&mut BTreeSet<String>) -> Result<()> {
    regular(directory,true)?;
    for entry in std::fs::read_dir(directory).map_err(|_|"执行器目录无法读取")? {
        let entry=entry.map_err(|_|"执行器目录无法读取")?;
        let path=entry.path(); let meta=std::fs::symlink_metadata(&path).map_err(|_|"执行器文件无法读取")?;
        if meta.is_dir() {actual_files(root,&path,found)?;} else {
            regular(&path,false)?;
            let raw=path.strip_prefix(root).map_err(|_|"执行器目录无效")?.to_str().ok_or("执行器路径无效")?.replace('\\',"/");
            artifact_path(root,&raw)?;
            found.insert(raw);
            if found.len()>10000 {return Err("执行器文件过多".into());}
        }
    }
    Ok(())
}

/// The trusted pin is compiled into the desktop, never read from runtime files.
pub(crate) fn verified_artifact(root:&Path) -> Result<PathBuf> {
    let pin:ArtifactPin=serde_json::from_str(include_str!("../../execution-worker.lock.json")).map_err(|_|"客户端执行器固定版本无效")?;
    verify_artifact_with_pin(root,&pin)
}

fn verify_artifact_with_pin(root:&Path,pin:&ArtifactPin) -> Result<PathBuf> {
    regular(root,true)?;
    let manifest_path=root.join("manifest.json"); regular(&manifest_path,false)?;
    if std::fs::metadata(&manifest_path).map_err(|_|"执行器清单缺失")?.len()>2*1024*1024 {return Err("执行器清单过大".into());}
    let raw=std::fs::read(&manifest_path).map_err(|_|"执行器清单缺失")?;
    let hash:String=digest::digest(&digest::SHA256,&raw).as_ref().iter().map(|b|format!("{b:02x}")).collect();
    if pin.protocol!=PROTOCOL || pin.build_id.is_empty() || pin.build_id.len()>128 || hash!=pin.manifest_sha256 {return Err("执行器清单不属于本客户端固定版本，请重新安装客户端".into());}
    let manifest:ArtifactManifest=serde_json::from_slice(&raw).map_err(|_|"执行器清单无效")?;
    if manifest.protocol!=PROTOCOL || manifest.entry!="execution-worker.exe" || manifest.build_id.is_empty() || manifest.build_id.len()>128 || manifest.files.is_empty() || manifest.files.len()>9999 {return Err("执行器版本不兼容".into());}
    if manifest.build_id!=pin.build_id {return Err("执行器构建编号与客户端固定版本不一致".into());}
    let mut expected=BTreeSet::from(["manifest.json".into()]);
    for item in manifest.files {
        let path=artifact_path(root,&item.path)?;
        if !expected.insert(item.path) || item.sha256.len()!=64 || !item.sha256.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {return Err("执行器清单重复或摘要无效".into());}
        regular(&path,false)?;
        let mut file=std::fs::File::open(path).map_err(|_|"执行器文件缺失")?;
        if file.metadata().map_err(|_|"执行器文件缺失")?.len()!=item.size {return Err("执行器文件长度不匹配".into());}
        let mut context=digest::Context::new(&digest::SHA256);let mut chunk=[0u8;65536];
        loop {let n=file.read(&mut chunk).map_err(|_|"执行器文件读取失败")?;if n==0 {break;}context.update(&chunk[..n]);}
        let hash:String=context.finish().as_ref().iter().map(|b|format!("{b:02x}")).collect();
        if hash!=item.sha256 {return Err("执行器文件摘要不匹配，请重新安装客户端".into());}
    }
    let mut actual=BTreeSet::new();actual_files(root,root,&mut actual)?;
    if actual!=expected || !expected.contains("execution-worker.exe") {return Err("执行器目录与构建清单不符".into());}
    Ok(root.join("execution-worker.exe"))
}

#[cfg(windows)]
struct ChildJob(crate::native_engine::win_job::JobHandle);
#[cfg(windows)]
impl Drop for ChildJob {fn drop(&mut self){crate::native_engine::win_job::close(self.0);}}

fn isolated_environment(command:&mut tokio::process::Command){
    command.env_clear();
    for name in ["SYSTEMROOT","WINDIR","TEMP","TMP","HOME","LANG","LC_ALL"]{if let Some(value)=std::env::var_os(name){command.env(name,value);}}
    // Do not discover missing Python/DLL dependencies through a developer's
    // venv or user PATH. The distribution and Windows system files suffice.
    #[cfg(windows)] if let Some(root)=std::env::var_os("SYSTEMROOT"){
        let root=PathBuf::from(root);
        if let Ok(path)=std::env::join_paths([root.join("System32"),root]){command.env("PATH",path);}
    }
    command.env("EXECUTOR_ISOLATED","1").env("PYTHONUTF8","1").env("PYTHONUNBUFFERED","1");
}

pub(crate) struct Worker {
    pub pid:u32,
    status:Arc<Mutex<WorkerStatus>>,
    stop:mpsc::Sender<()>,
    task:Option<tokio::task::JoinHandle<()>>,
}
impl Worker {
    pub fn status(&self)->Result<WorkerStatus>{self.status.lock().map(|s|{
        let mut status=s.clone();
        if status.state=="running" && status.last_status.elapsed()>Duration::from_secs(10){status.state="waiting_executor".into();status.error="WorkerStatusExpired".into();}
        status
    }).map_err(|_|"执行器状态不可用".into())}
    pub fn request_stop(&self){let _=self.stop.try_send(());}
    pub fn stopper(&self)->mpsc::Sender<()>{self.stop.clone()}
    pub fn finished(&self)->bool{self.task.as_ref().map(|t|t.is_finished()).unwrap_or(true)}
    pub async fn close(&mut self)->Result<WorkerStatus>{
        self.request_stop();
        if let Some(task)=self.task.take(){task.await.map_err(|_|"执行器退出未确认，请核对账户状态")?;}
        self.status()
    }
    pub fn launch(executable:&Path,database:&Path,account:&str,document:Zeroizing<Vec<u8>>)->Result<Self>{
        let mut command=tokio::process::Command::new(executable);
        command.args(["--database"]).arg(database).args(["--role","desktop","--control-stdin","--native-document"])
            .current_dir(executable.parent().ok_or("执行器路径无效")?);
        Self::launch_command(command,account,document,Duration::from_secs(45))
    }
    fn launch_command(mut command:tokio::process::Command,account:&str,document:Zeroizing<Vec<u8>>,grace:Duration)->Result<Self>{
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        isolated_environment(&mut command);
        #[cfg(windows)] command.creation_flags(0x08000000);
        let mut child=command.spawn().map_err(|_|"独立执行器启动失败，请重新安装客户端")?;
        let pid=child.id().ok_or("执行器启动未确认")?;
        // The child blocks on stdin. It receives no task/key until OS ownership
        // is installed successfully, so a parent crash cannot orphan trading.
        #[cfg(windows)]
        let job=match crate::native_engine::win_job::attach_kill_on_close(pid){Some(job)=>ChildJob(job),None=>{let _=child.start_kill();return Err("无法约束执行器进程，已阻止启动".into());}};
        let mut stdin=child.stdin.take().ok_or("执行器管道未建立")?;
        let stdout=child.stdout.take().ok_or("执行器管道未建立")?;
        let status=Arc::new(Mutex::new(WorkerStatus::new(account)));
        let reading=status.clone();
        let reader=tokio::spawn(async move {
            let mut stream=BufReader::new(stdout);
            loop {
                let mut raw=Vec::new();
                let n=(&mut stream).take(8193).read_until(b'\n',&mut raw).await.map_err(|_|())?;
                if n==0 {return Ok::<(),()>(());}
                reading.lock().map_err(|_|())?.accept(&raw).map_err(|_|())?;
            }
        });
        let (stop,mut control)=mpsc::channel(1);
        let updating=status.clone();
        let task=tokio::spawn(async move {
            #[cfg(windows)] let _job=job;
            let mut reader=reader;
            let sent=tokio::select! {
                result=tokio::time::timeout(Duration::from_secs(10),stdin.write_all(&document)) => matches!(result,Ok(Ok(()))),
                _=control.recv() => false,
            };
            drop(document);
            let mut invalid=!sent;
            let mut reader_done=false;
            let exit=if sent {
                tokio::select! {
                    result=child.wait()=>Some(result),
                    result=&mut reader=>{reader_done=true;invalid=!matches!(result,Ok(Ok(())));None},
                    _=control.recv()=>None,
                }
            } else {None};
            let exit=if let Some(exit)=exit {exit} else {
                // Closing the pipe also stops a bootstrap still in progress.
                let _=tokio::time::timeout(Duration::from_secs(2),stdin.write_all(b"{\"type\":\"stop\"}\n")).await;
                drop(stdin);
                match tokio::time::timeout(grace,child.wait()).await {
                    Ok(result)=>result,
                    Err(_)=>{invalid=true;let _=child.start_kill();child.wait().await},
                }
            };
            if !reader_done {match tokio::time::timeout(Duration::from_secs(2),&mut reader).await {
                Ok(Ok(Ok(())))=>{},_=>{invalid=true;reader.abort();let _=reader.await;},
            }}
            if let Ok(mut value)=updating.lock(){value.exited(exit.map(|s|s.success()).unwrap_or(false),invalid);}
        });
        Ok(Self{pid,status,stop,task:Some(task)})
    }
}
impl Drop for Worker {fn drop(&mut self){self.request_stop();}}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn stop_receipt_requires_exact_account_and_zero_exit() {
        let mut status = WorkerStatus::new("a");
        status.accept(br#"{"type":"executor-status","role":"desktop","account_id":"a","state":"running","error":""}"#).unwrap();
        status.exited(true, false);
        assert_eq!(status.state, "waiting_reconciliation");
        for (account, success, expected) in [("a", true, "stopped"), ("other", true, "waiting_reconciliation"), ("", true, "waiting_reconciliation"), ("a", false, "waiting_reconciliation")] {
            let mut status = WorkerStatus::new("a");
            status.accept(serde_json::json!({"type":"executor-status","role":"desktop","account_id":account,"state":"stopped","error":""}).to_string().as_bytes()).unwrap();
            status.exited(success, false);
            assert_eq!(status.state, expected);
        }
    }

    #[test]
    fn status_cannot_echo_credentials_or_believe_wrong_role() {
        let mut status = WorkerStatus::new("a");
        status.accept(br#"{"type":"executor-status","role":"server","account_id":"a","state":"running"}"#).unwrap();
        assert_ne!(status.state, "running");
        status.accept(br#"{"type":"executor-status","role":"desktop","account_id":"a","state":"running","error":"ac_secret:password"}"#).unwrap();
        assert!(status.error.is_empty());
        assert!(status.accept(&vec![b'x';8193]).is_err());
        assert!(status.accept(br#"{"type":"executor-status","role":"desktop","account_id":"a","state":"secret"}"#).is_err());
    }

    #[test]
    fn manifest_paths_cannot_escape_or_ship_private_source() {
        for path in ["../app.py", "C:/secret.dll", "nested/../x.dll", "app.py", "APP.PYC", ".env", "folder\\x.dll", "a//b.dll", "module.pyw"] {
            assert!(artifact_path(Path::new("root"), path).is_err(), "{path}");
        }
        assert_eq!(artifact_path(Path::new("root"), "crypto/_rust.pyd").unwrap(), Path::new("root").join("crypto/_rust.pyd"));
    }

    #[test]
    fn hashes_cover_the_entry_and_reject_unlisted_or_changed_files(){
        let root=std::env::temp_dir().join(format!("executor-manifest-test-{}",std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let binary=b"synthetic native artifact";
        let hash:String=digest::digest(&digest::SHA256,binary).as_ref().iter().map(|b|format!("{b:02x}")).collect();
        std::fs::write(root.join("execution-worker.exe"),binary).unwrap();
        let document=serde_json::json!({"protocol":1,"entry":"execution-worker.exe","build_id":"test","files":[{"path":"execution-worker.exe","size":binary.len(),"sha256":hash}]}).to_string();
        std::fs::write(root.join("manifest.json"),&document).unwrap();
        let pin=ArtifactPin{protocol:1,build_id:"test".into(),manifest_sha256:digest::digest(&digest::SHA256,document.as_bytes()).as_ref().iter().map(|b|format!("{b:02x}")).collect()};
        assert!(verify_artifact_with_pin(&root,&pin).is_ok());
        std::fs::write(root.join("rogue.dll"),b"unlisted").unwrap();
        assert!(verify_artifact_with_pin(&root,&pin).is_err());
        std::fs::remove_file(root.join("rogue.dll")).unwrap();
        std::fs::write(root.join("execution-worker.exe"),b"modified").unwrap();
        assert!(verify_artifact_with_pin(&root,&pin).is_err());
        // Only remove individually named files from this test-owned directory.
        std::fs::remove_file(root.join("execution-worker.exe")).unwrap();
        std::fs::remove_file(root.join("manifest.json")).unwrap();std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn self_consistent_but_unpinned_runtime_cannot_receive_a_preparation(){
        let root=std::env::temp_dir().join(format!("executor-unpinned-test-{}",std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let binary=b"self consistent but not this desktops fixed native runtime";
        let fixed:Value=serde_json::from_str(include_str!("../../execution-worker.lock.json")).unwrap();
        let hash:String=digest::digest(&digest::SHA256,binary).as_ref().iter().map(|b|format!("{b:02x}")).collect();
        std::fs::write(root.join("execution-worker.exe"),binary).unwrap();
        // Even copying the correct build ID cannot authorize different bytes.
        std::fs::write(root.join("manifest.json"),serde_json::json!({"protocol":1,"entry":"execution-worker.exe","build_id":fixed["build_id"],"files":[{"path":"execution-worker.exe","size":binary.len(),"sha256":hash}]}).to_string()).unwrap();
        let result=verified_artifact(&root);
        std::fs::remove_file(root.join("execution-worker.exe")).unwrap();
        std::fs::remove_file(root.join("manifest.json")).unwrap();std::fs::remove_dir(root).unwrap();
        assert!(result.is_err(),"An internally consistent manifest cannot replace the compiled distribution pin");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn real_native_child_drains_and_unconfirmed_exit_stays_blocked(){
        for (ending,expected) in [
            ("[Console]::ReadLine() | Out-Null; [Console]::WriteLine('{\"type\":\"executor-status\",\"role\":\"desktop\",\"account_id\":\"a\",\"state\":\"stopped\",\"error\":\"\"}')", "stopped"),
            ("[Console]::ReadLine() | Out-Null", "waiting_reconciliation"),
            ("[Console]::ReadLine() | Out-Null; exit 7", "waiting_reconciliation"),
            ("Start-Sleep -Seconds 30", "waiting_reconciliation"),
        ] {
            let script=format!("[Console]::ReadLine() | Out-Null; [Console]::WriteLine('{{\"type\":\"executor-status\",\"role\":\"desktop\",\"account_id\":\"a\",\"state\":\"running\",\"error\":\"\"}}'); {ending}");
            let mut command=tokio::process::Command::new(PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
            command.args(["-NoProfile","-NonInteractive","-Command",&script]);
            let mut worker=Worker::launch_command(command,"a",Zeroizing::new(b"{\"synthetic\":true}\n".to_vec()),Duration::from_millis(100)).unwrap();
            tokio::time::timeout(Duration::from_secs(10),async {
                loop {if worker.status().unwrap().state=="running"{break;}assert!(!worker.finished(),"child exited before test readiness");tokio::time::sleep(Duration::from_millis(10)).await;}
            }).await.unwrap();
            {
                worker.status.lock().unwrap().last_status=std::time::Instant::now()-Duration::from_secs(11);
                assert_eq!(worker.status().unwrap().state,"waiting_executor");
            }
            let status=worker.close().await.unwrap();
            assert!(worker.finished());assert_eq!(status.state,expected);
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires the privately compiled distribution assembled in ignored resources"]
    async fn compiled_distribution_self_test_and_rejected_bootstrap_use_native_process_contract(){
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/execution-worker");
        let executable=verified_artifact(&root).unwrap();
        let mut command=tokio::process::Command::new(&executable);
        command.arg("--self-test").current_dir(&root);
        isolated_environment(&mut command);
        command.creation_flags(0x08000000);
        let output=tokio::time::timeout(Duration::from_secs(60),command.output()).await.unwrap().unwrap();
        assert!(output.status.success(),"compiled self-test did not succeed");
        let status:serde_json::Value=serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status,serde_json::json!({"type":"executor-runtime","protocol":1,"sqlite":true,"private_strategy":true,"isolated":true}));
        // Rejected before opening a database or making any gateway request.
        // This checks the actual executable/stdin/Job Object contract without
        // granting an account, restoring a task, or sending a financial request.
        let database=std::env::temp_dir().join(format!("executor-rejected-bootstrap-{}.db",std::process::id()));
        assert!(!database.exists());
        let mut worker=Worker::launch(&executable,&database,"synthetic-account",Zeroizing::new(b"{\"document\":{}}\n".to_vec())).unwrap();
        tokio::time::timeout(Duration::from_secs(30),async {
            while !worker.finished(){tokio::time::sleep(Duration::from_millis(20)).await;}
        }).await.unwrap();
        let status=tokio::time::timeout(Duration::from_secs(30),worker.close()).await.unwrap().unwrap();
        assert_eq!(status.state,"waiting_reconciliation");
        assert!(!database.exists());
    }
}

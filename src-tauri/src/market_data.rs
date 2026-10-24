//! The long-lived market Key stays encrypted with the Windows user's DPAPI.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;
use zeroize::Zeroizing;

const BASE: &str = "https://lium.eu.org";
pub struct MarketDataState {
    pub(crate) client: Client,
    pub(crate) direct: std::sync::atomic::AtomicBool,
    private_slot:tokio::sync::Mutex<Option<std::time::Instant>>,
    pub(crate) manual_slot:tokio::sync::Mutex<()>,
}
impl Default for MarketDataState {
    fn default() -> Self {
        Self {
            direct:std::sync::atomic::AtomicBool::new(false),
            private_slot:tokio::sync::Mutex::new(None),
            manual_slot:tokio::sync::Mutex::new(()),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("market HTTP pool"),
        }
    }
}

fn target(path: &str) -> Result<Url, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['#', '\\']) {
        return Err("不支持的行情地址".into());
    }
    let url = Url::parse(&format!("{BASE}{path}")).map_err(|_| "无效行情地址")?;
    if ![
        "/v1/my/permissions",
        "/v1/capabilities",
        "/v1/symbol-capabilities",
        "/v1/symbols",
        "/api/tickets",
        "/edge/data",
        "/edge/okx",
        "/v1/execution/acquire", "/v1/execution/renew", "/v1/execution/release", "/v1/execution/intents",
        "/v1/execution/unresolved", "/v1/execution/confirm-flat", "/v1/execution/stop-account", "/v1/execution/account-for-key",
        "/v1/execution/authority-keys", "/v1/execution/accounts",
        "/v1/execution/manual/submit", "/v1/execution/manual/state", "/v1/execution/manual/cancel",
    ]
    .contains(&url.path())
        || url.query_pairs().any(|(k, _)| {
            ["apikey", "api_key", "key", "authorization"].contains(&k.to_ascii_lowercase().as_str())
        })
    {
        return Err("不支持的行情请求".into());
    }
    Ok(url)
}

fn key_path(app: &tauri::AppHandle, scope: &str) -> Result<PathBuf, String> {
    if scope.is_empty() || scope.len() > 512 {
        return Err("请先登录桌面账号".into());
    }
    let hash = ring::digest::digest(&ring::digest::SHA256, scope.as_bytes());
    let name: String = hash.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法读取本机配置目录")?
        .join("market-keys")
        .join(format!("{name}.bin")))
}

#[cfg(windows)]
pub(crate) fn protect(input: &[u8], entropy: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            a: *const Blob,
            b: *const u16,
            c: *const Blob,
            d: *mut std::ffi::c_void,
            e: *mut std::ffi::c_void,
            f: u32,
            g: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            a: *const Blob,
            b: *mut *mut u16,
            c: *const Blob,
            d: *mut std::ffi::c_void,
            e: *mut std::ffi::c_void,
            f: u32,
            g: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(p: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let source = Blob {
        len: input.len() as u32,
        data: input.as_ptr() as *mut u8,
    };
    let context = Blob {
        len: entropy.len() as u32,
        data: entropy.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // DPAPI allocation belongs to LocalFree. UI is forbidden for unattended startup.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                &context,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                &context,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("无法解密行情 Key，请重新配置".into());
        }
        let bytes = std::slice::from_raw_parts(output.data, output.len as usize).to_vec();
        std::ptr::write_bytes(output.data, 0, output.len as usize);
        LocalFree(output.data.cast());
        Ok(bytes)
    }
}
#[cfg(not(windows))]
pub(crate) fn protect(_: &[u8], _: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("此版本仅支持 Windows 安全保存行情 Key".into())
}

pub(crate) fn read_key(app: &tauri::AppHandle, scope: &str) -> Result<Zeroizing<String>, String> {
    let sealed = std::fs::read(key_path(app, scope)?).map_err(|_| "请在个人中心配置数据 Key")?;
    let plain = Zeroizing::new(protect(&sealed, scope.as_bytes(), false)?);
    Ok(Zeroizing::new(
        String::from_utf8(plain.to_vec()).map_err(|_| "行情 Key 配置损坏，请重新填写")?,
    ))
}

async fn request(
    state: &MarketDataState,
    key: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = target(path)?;
    let mut req = if path.starts_with("/api/tickets") {
        state
            .client
            .post(url)
            .json(&body.ok_or("缺少行情请求参数")?)
    } else if url.path() == "/edge/okx" {
        state
            .client
            .post(url)
            .timeout(Duration::from_secs(8))
            .json(&body.ok_or("缺少交易所签名请求")?)
    } else if url.path().starts_with("/v1/execution/") && body.is_some() {
        state.client.post(url).json(&body.ok_or("缺少执行权参数")?)
    } else {
        state.client.get(url)
    };
    if !path.starts_with("/edge/") {
        req = req.header("X-API-Key", key);
    }
    let response = req
        .send()
        .await
        .map_err(|_| "行情网络连接失败，请稍后重试")?;
    let value: Value = response.json().await.map_err(|_| "行情响应格式异常")?;
    Ok(value)
}

pub(crate) async fn private_request<F>(
    app: &tauri::AppHandle,
    state: &MarketDataState,
    scope: &str,
    sign:F,
) -> Result<Value, String> where F:FnOnce()->Result<Value,String> {
    if state.direct.load(std::sync::atomic::Ordering::SeqCst){
        let mut slot=state.private_slot.lock().await;
        if let Some(previous)=*slot{let wait=Duration::from_millis(250).saturating_sub(previous.elapsed());if !wait.is_zero(){tokio::time::sleep(wait).await;}}
        *slot=Some(std::time::Instant::now());
        let body=sign()?;
        if body["method"]!="GET"{return Err("金融写入必须经过已授权的执行权通道".into())}
        return crate::okx_direct::signed_request(&state.client,&body).await;
    }
    private_command(app,state,scope,sign,||Ok(())).await
}

pub(crate) async fn execution_request(app:&tauri::AppHandle,state:&MarketDataState,scope:&str,path:&str,body:Option<Value>)->Result<Value,String>{
    if !path.starts_with("/v1/execution/"){return Err("无效的执行权地址".into())}
    let key=read_key(app,scope)?;
    let reply=request(state,&key,path,body).await?;
    if reply["code"]!=200{
        let code=reply["msg"].as_str().or_else(||reply["detail"].as_str()).unwrap_or("执行通道未启用");
        let message=match code{
            "execution_not_enabled"=>"接口中心尚未启用本机交易执行通道",
            "execution_busy"=>"账户正由另一执行器管理，请等待执行权释放后重试",
            "manual_legacy_intent_exists"=>"该请求已有原始金融指令，只能核对原委托，不能改成队列重新发送",
            "manual_control_pending"=>"账户已有人工请求待核对，请先核对上一笔人工操作",
            "unresolved_commands"=>"上一笔交易结果尚未确认，已阻止重复操作",
            "reconciliation_required"=>"账户状态已变化，请刷新后重新核对",
            "enrollment_draining"=>"账户正在交接，请稍后重新核对",
            "manual_flatten_required"=>"账户已停机锁定，请先撤单、手动平仓并核对平仓状态",
            "execution_fenced"=>"执行权已失效，请重新核对账户后操作",
            "execution_state_changed"=>"账户执行状态已变化，本次停止未执行；请刷新后重新确认",
            "executor_process_stopped"=>"旧执行器进程已停止，不能恢复旧心跳",
            "server_registration_required"=>"当前账户尚未登记服务器任务",
            _=>code,
        };
        return Err(format!("接口中心执行权校验失败：{message}"))
    }
    Ok(reply["data"].clone())
}

pub(crate) async fn private_command<F,B>(app:&tauri::AppHandle,state:&MarketDataState,scope:&str,sign:F,before_send:B)->Result<Value,String>
where F:FnOnce()->Result<Value,String>, B:FnOnce()->Result<(),String>{
    let mut slot=state.private_slot.lock().await;
    if let Some(previous)=*slot{
        let wait=Duration::from_millis(750).saturating_sub(previous.elapsed());
        if !wait.is_zero(){tokio::time::sleep(wait).await;}
    }
    *slot=Some(std::time::Instant::now());
    // Sign after queueing so another card's slow query cannot expire this proof.
    let key = read_key(app, scope)?;
    let ticket=request(state,&key,"/api/tickets",Some(json!({"market_type":"crypto","exchange":"okx","symbol":"BTC-USDT-SWAP","operation":"okx_private"}))).await?;
    if ticket["code"] != 200 {
        return Err(ticket["msg"].as_str().unwrap_or("账户接口未授权").into());
    }
    let address = private_target(ticket["data"]["url"].as_str().ok_or("无效账户票据")?)?;
    let path = format!(
        "{}?{}",
        address.path(),
        address.query().ok_or("缺少账户票据")?
    );
    let body=sign()?;
    // Commit the immutable command before it can leave the process.
    before_send()?;
    let reply = request(state, &key, &path, Some(body)).await?;
    if reply["code"] != 200 {
        return Err(reply["msg"].as_str().unwrap_or("账户接口读取失败").into());
    }
    serde_json::from_str(
        reply["data"]["raw"]
            .as_str()
            .ok_or("账户接口响应格式错误")?,
    )
    .map_err(|_| "账户接口响应格式错误".into())
}

fn private_target(raw: &str) -> Result<Url, String> {
    let address = Url::parse(BASE)
        .map_err(|_| "无效接口地址")?
        .join(raw)
        .map_err(|_| "无效账户票据")?;
    if address.origin().ascii_serialization() != BASE
        || address.path() != "/edge/okx"
        || !address.username().is_empty()
        || address.password().is_some()
        || address.fragment().is_some()
        || address.query_pairs().count() != 1
        || address
            .query_pairs()
            .any(|(key, value)| key != "ticket" || value.is_empty())
    {
        return Err("无效账户票据地址".into());
    }
    Ok(address)
}

#[tauri::command]
pub async fn collection_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, MarketDataState>,
    scope: String,
    action: String,
    key: Option<String>,
) -> Result<Value, String> {
    let path = key_path(&app, &scope)?;
    match action.as_str() {
        "clear" => {
            crate::execution_runtime::invalidate_account(&app,&scope);
            if path.exists() {
                std::fs::remove_file(path).map_err(|_| "清除行情 Key 失败")?;
            }
            crate::execution_runtime::invalidate_account(&app,&scope);
            Ok(json!({"configured":false}))
        }
        "status" => {
            if !path.exists() {
                return Ok(json!({"configured":false}));
            }
            let k = read_key(&app, &scope)?;
            Ok(
                json!({"configured":true,"masked":format!("{}…",k.chars().take(10).collect::<String>())}),
            )
        }
        "test" | "save" => {
            let key = Zeroizing::new(key.unwrap_or_default().trim().to_string());
            if !key.starts_with("ac_")
                || key.len() < 20
                || key.len() > 160
                || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("请填写有效的 API Key".into());
            }
            let permissions = request(&state, &key, "/v1/my/permissions", None).await?;
            if permissions["code"] != 200 {
                return Err("Key 无效、已过期或未开通套餐".into());
            }
            if action == "save" {
                std::fs::create_dir_all(path.parent().ok_or("配置路径无效")?)
                    .map_err(|_| "无法保存行情 Key")?;
                let encrypted = protect(key.as_bytes(), scope.as_bytes(), true)?;
                let temp = path.with_extension("tmp");
                std::fs::write(&temp, encrypted).map_err(|_| "无法保存行情 Key")?;
                crate::execution_runtime::invalidate_account(&app,&scope);
                std::fs::rename(temp, path).map_err(|_| "无法保存行情 Key")?;
                crate::execution_runtime::invalidate_account(&app,&scope);
            }
            Ok(
                json!({"configured":action=="save","masked":format!("{}…",key.chars().take(10).collect::<String>()),"permissions":permissions["data"]}),
            )
        }
        _ => Err("不支持的 Key 操作".into()),
    }
}

#[tauri::command]
pub async fn collection_http(
    app: tauri::AppHandle,
    state: tauri::State<'_, MarketDataState>,
    scope: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let key = read_key(&app, &scope)?;
    request(&state, &key, &path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_market_targets() {
        assert!(target("/api/tickets").is_ok());
        for path in [
            "//evil.test/api/tickets",
            "/api/live/orders",
            "/edge/data?apiKey=hidden",
            "/v1/../api/live/orders",
        ] {
            assert!(target(path).is_err());
        }
        assert!(private_target("/edge/okx?ticket=one-use").is_ok());
        assert!(private_target("https://lium.eu.org/edge/okx?ticket=one-use").is_ok());
        for raw in [
            "https://other.example/edge/okx?ticket=x",
            "https://user@lium.eu.org/edge/okx?ticket=x",
            "/edge/okx?ticket=x&key=x",
            "/edge/data?ticket=x",
        ] {
            assert!(private_target(raw).is_err());
        }
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_is_scoped_and_tamper_evident() {
        let mut sealed = protect(b"synthetic-market-key", b"account-a", true).unwrap();
        assert_ne!(sealed, b"synthetic-market-key");
        assert_eq!(
            protect(&sealed, b"account-a", false).unwrap(),
            b"synthetic-market-key"
        );
        assert!(protect(&sealed, b"account-b", false).is_err());
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(protect(&sealed, b"account-a", false).is_err());
    }
}

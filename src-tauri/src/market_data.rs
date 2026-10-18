//! The long-lived market Key stays encrypted with the Windows user's DPAPI.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;
use zeroize::Zeroizing;

const BASE: &str = "https://lium.eu.org";
pub struct MarketDataState {
    client: Client,
}
impl Default for MarketDataState {
    fn default() -> Self {
        Self {
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
fn protect(input: &[u8], entropy: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
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
fn protect(_: &[u8], _: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("此版本仅支持 Windows 安全保存行情 Key".into())
}

fn read_key(app: &tauri::AppHandle, scope: &str) -> Result<Zeroizing<String>, String> {
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
            if path.exists() {
                std::fs::remove_file(path).map_err(|_| "清除行情 Key 失败")?;
            }
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
                std::fs::rename(temp, path).map_err(|_| "无法保存行情 Key")?;
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

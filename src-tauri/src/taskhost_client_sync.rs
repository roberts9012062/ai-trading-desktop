//! Selected-profile configuration transfer. DPAPI plaintext never reaches the renderer.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq)]
struct Binding {
    scope: String,
    origin: String,
    owner: String,
    token_hash: String,
}
#[derive(Default)]
pub struct ClientSyncState {
    binding: Mutex<Option<Binding>>,
    generation: AtomicU64,
    changed: tokio::sync::Notify,
}
fn digest(raw: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, raw)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn origin(raw: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw).map_err(|_| "任务服务器地址无效")?;
    let local = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (parsed.scheme() != "https" && !(parsed.scheme() == "http" && local))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || parsed.host_str().is_none()
    {
        return Err("任务服务器地址必须是 HTTPS 源站，本机可使用 HTTP".into());
    }
    let value = parsed.origin().ascii_serialization();
    if value != raw {
        return Err("任务服务器地址未规范化".into());
    }
    Ok(value)
}
fn binding(scope: &str, base: &str, owner: &str, token: &str) -> Result<Binding, String> {
    if scope.is_empty()
        || scope.len() > 512
        || scope.ends_with(":anonymous")
        || scope.chars().any(char::is_control)
        || owner.is_empty()
        || owner.len() > 128
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || token.is_empty()
        || token.len() > 1024
        || !token.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err("请在当前本地实盘配置中重新连接任务服务器".into());
    }
    Ok(Binding {
        scope: scope.into(),
        origin: origin(base)?,
        owner: owner.into(),
        token_hash: digest(token.as_bytes()),
    })
}
impl ClientSyncState {
    fn bind(&self, next: Option<Binding>) -> Result<u64, String> {
        let mut state = self.binding.lock().map_err(|_| "同步会话正在恢复")?;
        if *state != next {
            *state = next;
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.changed.notify_waiters();
        }
        Ok(self.generation.load(Ordering::SeqCst))
    }
    fn current(&self, expected: &Binding, generation: u64) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) != generation
            || self
                .binding
                .lock()
                .map_err(|_| "同步会话正在恢复")?
                .as_ref()
                != Some(expected)
        {
            return Err("账号或服务器连接已变化，已取消原配置同步".into());
        }
        Ok(())
    }
}
#[tauri::command]
pub fn taskhost_client_sync_context(
    state: tauri::State<'_, ClientSyncState>,
    scope: Option<String>,
    origin: Option<String>,
    owner_id: Option<String>,
    token: Option<String>,
) -> Result<u64, String> {
    let token = Zeroizing::new(token.unwrap_or_default());
    let next = match (scope, origin, owner_id) {
        (None, None, None) => None,
        (Some(scope), Some(base), Some(owner)) => Some(binding(&scope, &base, &owner, &token)?),
        _ => return Err("配置同步会话不完整".into()),
    };
    state.bind(next)
}
#[derive(Serialize)]
struct Credential<'a> {
    client_id: String,
    venue: &'static str,
    label: &'a str,
    api_key: &'a str,
    secret: &'a str,
    passphrase: &'a str,
    demo: bool,
}
#[derive(Serialize)]
struct Payload<'a> {
    request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    collection_key: Option<&'a str>,
    credentials: Vec<Credential<'a>>,
}
#[derive(Deserialize, Serialize)]
struct CredentialInfo {
    client_id: String,
    credential_id: String,
    venue: String,
    label: String,
    demo: bool,
    api_key_masked: String,
}
#[derive(Deserialize, Serialize)]
struct Receipt {
    sync_id: String,
    credentials: Vec<CredentialInfo>,
    collection_configured: bool,
    collection_status: String,
    data_status: String,
    execution_authority: bool,
    tasks_created: bool,
}
fn valid_request_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn valid_hash(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn validate_receipt(raw: &[u8], request: &str, clients: &[String]) -> Result<Receipt, String> {
    let receipt: Receipt = serde_json::from_slice(raw).map_err(|_| "服务器配置同步回执无效")?;
    if receipt.sync_id != request
        || receipt.execution_authority
        || receipt.tasks_created
        || receipt.credentials.len() != clients.len()
        || ![
            "pending_verification",
            "not_configured",
            "verified",
            "unavailable",
            "identity_conflict",
        ]
        .contains(&receipt.collection_status.as_str())
        || !["pending", "ok", "unavailable"].contains(&receipt.data_status.as_str())
        || receipt.credentials.iter().any(|c| {
            !valid_hash(&c.client_id)
                || !clients.contains(&c.client_id)
                || !valid_request_id(&c.credential_id)
                || c.venue != "okx"
                || c.label.len() > 100
                || c.api_key_masked.len() > 100
        })
    {
        return Err("服务器配置同步回执不匹配".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    if !receipt
        .credentials
        .iter()
        .all(|c| seen.insert(&c.client_id))
    {
        return Err("服务器返回重复的配置身份".into());
    }
    Ok(receipt)
}
fn client_id(scope: &str, key: &str, demo: bool) -> String {
    digest(format!("taskhost-client-okx-v1\0{scope}\0{key}\0{demo}").as_bytes())
}

#[tauri::command]
pub async fn taskhost_client_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClientSyncState>,
    scope: String,
    generation: u64,
    origin: String,
    owner_id: String,
    token: String,
    request_id: String,
) -> Result<Value, String> {
    let token = Zeroizing::new(token);
    let expected = binding(&scope, &origin, &owner_id, &token)?;
    if !valid_request_id(&request_id) {
        return Err("配置同步请求编号无效".into());
    }
    state.current(&expected, generation)?;
    let key = crate::market_data::saved_key(&app, &scope)?;
    let credentials = crate::local_exchange::credentials(
        &app,
        &app.state::<crate::local_store::LocalStoreState>(),
        &scope,
    )?;
    state.current(&expected, generation)?;
    if key.is_none() && credentials.is_none() {
        return Ok(json!({"sent":false,"reason":"local_configuration_missing"}));
    }
    let rows = credentials
        .as_ref()
        .map(|c| Credential {
            client_id: client_id(&scope, &c.api_key, c.demo),
            venue: "okx",
            label: if c.label.is_empty() {
                "本地 OKX 账户"
            } else {
                &c.label
            },
            api_key: &c.api_key,
            secret: &c.secret,
            passphrase: &c.passphrase,
            demo: c.demo,
        })
        .into_iter()
        .collect::<Vec<_>>();
    let clients = rows
        .iter()
        .map(|row| row.client_id.clone())
        .collect::<Vec<_>>();
    let payload = Payload {
        request_id: &request_id,
        collection_key: key.as_deref().map(|v| v.as_str()),
        credentials: rows,
    };
    let raw = Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| "本地配置无法编码")?);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|_| "配置同步连接初始化失败")?;
    let request = client
        .post(format!("{origin}/api/v1/client-sync"))
        .bearer_auth(token.as_str())
        .header("Content-Type", "application/json")
        .body(raw.to_vec())
        .build()
        .map_err(|_| "配置同步请求无法准备")?;
    let cancelled = state.changed.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();
    state.current(&expected, generation)?;
    let response = tokio::select! {_=&mut cancelled=>return Err("账号已变化，已取消原配置同步".into()),result=client.execute(request)=>result.map_err(|_|"服务器配置同步未确认，请稍后核对；未创建或启动任务")?};
    state.current(&expected, generation)?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "服务器连接已过期，请重新握手后同步配置",
            404 => "服务器尚未支持自动配置同步，请升级服务器",
            409 => "服务器配置身份冲突，请在原账户核对；没有覆盖原配置",
            _ => "服务器配置同步未确认，请稍后核对；未创建或启动任务",
        }
        .into());
    }
    let read = async {
        let mut response = response;
        let mut raw = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| "配置同步回执中断")? {
            if raw.len() + chunk.len() > 128 * 1024 {
                return Err("配置同步回执过大".into());
            }
            raw.extend_from_slice(&chunk);
        }
        Ok::<_, String>(raw)
    };
    let raw = tokio::select! {_=&mut cancelled=>return Err("账号已变化，已取消原配置同步".into()),raw=read=>raw?};
    state.current(&expected, generation)?;
    let receipt = validate_receipt(&raw, &request_id, &clients)?;
    Ok(json!({"sent":true,"receipt":receipt}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_owner_and_server_generations_cannot_cross() {
        let state = ClientSyncState::default();
        let a = binding(
            "https://old.invalid:user-a",
            "https://host.invalid",
            "owner-a",
            "session-a",
        )
        .unwrap();
        let generation = state.bind(Some(a.clone())).unwrap();
        assert!(state.current(&a, generation).is_ok());
        let mut b = a.clone();
        b.owner = "owner-b".into();
        state.bind(Some(b)).unwrap();
        assert!(state.current(&a, generation).is_err());
        assert!(binding("old:anonymous", "https://host.invalid", "owner", "token").is_err());
    }
    #[test]
    fn configuration_targets_never_accept_redirect_origins_or_secret_urls() {
        for base in [
            "http://remote.invalid",
            "https://u:secret@host.invalid",
            "https://host.invalid/api",
            "https://host.invalid?key=secret",
        ] {
            assert!(origin(base).is_err());
        }
        assert_eq!(
            origin("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
    }
    #[test]
    fn stable_client_identity_preserves_demo_and_profile_isolation() {
        let a = client_id("s:user-a", "synthetic-api-key", false);
        assert_eq!(a, client_id("s:user-a", "synthetic-api-key", false));
        assert_ne!(a, client_id("s:user-a", "synthetic-api-key", true));
        assert_ne!(a, client_id("s:user-b", "synthetic-api-key", false));
    }
    #[test]
    fn receipt_redaction_and_authority_rejection() {
        let id = "12345678-1234-4234-8234-123456789001";
        let mut receipt = json!({"sync_id":id,"credentials":[],"collection_configured":true,"collection_status":"pending_verification","data_status":"pending","execution_authority":false,"tasks_created":false,"private_unexpected":"synthetic-secret"});
        let safe = validate_receipt(&serde_json::to_vec(&receipt).unwrap(), id, &[]).unwrap();
        assert!(!serde_json::to_string(&safe)
            .unwrap()
            .contains("synthetic-secret"));
        receipt["execution_authority"] = json!(true);
        assert!(validate_receipt(&serde_json::to_vec(&receipt).unwrap(), id, &[]).is_err());
    }
}

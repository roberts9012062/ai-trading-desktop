//! Local read-only OKX authentication. Secrets never cross the renderer IPC.
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{aead, agreement, hkdf, hmac, rand};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

const PROXY: &str = "https://okx-rest-test.kins.eu.org";
const CONTEXT: &[u8] = b"cyclepilot/desktop-okx-read/v1";

#[derive(Clone, Deserialize)]
struct Credentials {
    api_key: String,
    secret: String,
    passphrase: String,
    demo: bool,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.api_key.zeroize();
        self.secret.zeroize();
        self.passphrase.zeroize();
    }
}
#[derive(Deserialize)]
struct Envelope {
    version: u32,
    public_key: String,
    nonce: String,
    ciphertext: String,
}
struct Lease {
    identity: Vec<u8>,
    credentials: Credentials,
    clock_offset: i64,
    until: Instant,
}
pub struct OkxAnalyticsState {
    lease: Arc<Mutex<Option<Lease>>>,
    client: reqwest::Client,
}
impl Default for OkxAnalyticsState {
    fn default() -> Self {
        Self {
            lease: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()
                .expect("HTTPS analytics client"),
        }
    }
}

fn server_base(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "无效的服务器地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("本地凭证同步需要 HTTPS 服务器地址".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

fn allowed_path(path: &str) -> bool {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if !matches!(
        route,
        "/api/v5/account/bills" | "/api/v5/account/bills-archive" | "/api/v5/trade/fills-history"
    ) || path.len() > 1024
        || query.is_empty()
        || path.contains('#')
        || path.contains('%')
    {
        return false;
    }
    let params: Vec<_> = reqwest::Url::parse(&(PROXY.to_owned() + path))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default();
    params.iter().any(|(k, v)| k == "instType" && v == "SWAP")
        && params.iter().all(|(k, v)| match k.as_str() {
            "instType" => v == "SWAP",
            "limit" => v == "100",
            "begin" | "end" | "after" => {
                !v.is_empty() && v.len() <= 24 && v.bytes().all(|b| b.is_ascii_digit())
            }
            _ => false,
        })
}

fn decrypt_envelope(
    private: agreement::EphemeralPrivateKey,
    client_public: &[u8],
    envelope: Envelope,
) -> Result<Credentials, String> {
    let failure = || "桌面凭证解密失败".to_string();
    if envelope.version != 1 {
        return Err(failure());
    }
    let peer_bytes = STANDARD
        .decode(envelope.public_key)
        .map_err(|_| failure())?;
    let nonce: [u8; 12] = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| failure())?
        .try_into()
        .map_err(|_| failure())?;
    let mut cipher = Zeroizing::new(
        STANDARD
            .decode(envelope.ciphertext)
            .map_err(|_| failure())?,
    );
    let aad = [CONTEXT, client_public, peer_bytes.as_slice()].concat();
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, &peer_bytes);
    let mut key = Zeroizing::new([0u8; 32]);
    struct KeyLength;
    impl hkdf::KeyType for KeyLength {
        fn len(&self) -> usize {
            32
        }
    }
    agreement::agree_ephemeral(private, &peer, |shared| {
        hkdf::Salt::new(hkdf::HKDF_SHA256, &[])
            .extract(shared)
            .expand(&[&aad], KeyLength)
            .and_then(|okm| okm.fill(key.as_mut()))
    })
    .map_err(|_| failure())?
    .map_err(|_| failure())?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key.as_ref()).map_err(|_| failure())?,
    );
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(&aad),
            &mut cipher,
        )
        .map_err(|_| failure())?;
    let credentials: Credentials = serde_json::from_slice(plaintext).map_err(|_| failure())?;
    if credentials.api_key.is_empty()
        || credentials.secret.is_empty()
        || credentials.passphrase.is_empty()
    {
        return Err(failure());
    }
    Ok(credentials)
}

fn now_ms() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间错误")?
        .as_millis() as i64)
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!("查询失败 HTTP {}", response.status().as_u16()));
    }
    let mut response = response;
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "查询响应中断")? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("查询响应超出限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "查询响应格式错误".into())
}

fn sign(secret: &str, timestamp: &str, path: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    STANDARD.encode(hmac::sign(&key, format!("{timestamp}GET{path}").as_bytes()).as_ref())
}

fn retryable(error: &str) -> bool {
    matches!(
        error,
        "Snippet 收益查询连接失败" | "查询响应中断" | "OKX 请求限流"
    ) || [408, 429, 500, 502, 503, 504]
        .iter()
        .any(|status| error == format!("查询失败 HTTP {status}"))
}

#[tauri::command]
pub async fn okx_analytics_clear(state: tauri::State<'_, OkxAnalyticsState>) -> Result<(), String> {
    *state.lease.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn okx_analytics_read(
    base: String,
    token: String,
    path: String,
    state: tauri::State<'_, OkxAnalyticsState>,
) -> Result<Value, String> {
    read_analytics(base, token, path, &state).await
}

async fn read_analytics(
    base: String,
    token: String,
    path: String,
    state: &OkxAnalyticsState,
) -> Result<Value, String> {
    if !allowed_path(&path) || token.is_empty() {
        return Err("不支持的本地收益查询".into());
    }
    let base = server_base(&base)?;
    let identity =
        ring::digest::digest(&ring::digest::SHA256, format!("{base}\0{token}").as_bytes())
            .as_ref()
            .to_vec();
    let client = &state.client;
    let (credentials, offset) = {
        let mut guard = state.lease.lock().await;
        if !guard
            .as_ref()
            .is_some_and(|lease| lease.identity == identity && Instant::now() < lease.until)
        {
            *guard = None;
            let private = agreement::EphemeralPrivateKey::generate(
                &agreement::X25519,
                &rand::SystemRandom::new(),
            )
            .map_err(|_| "桌面密钥生成失败")?;
            let public = private
                .compute_public_key()
                .map_err(|_| "桌面密钥生成失败")?;
            let response = client
                .post(format!("{base}/api/live/desktop-read-credentials"))
                .bearer_auth(&token)
                .json(&json!({"public_key": STANDARD.encode(public.as_ref())}))
                .send()
                .await
                .map_err(|_| "桌面凭证同步失败")?;
            let envelope: Envelope = serde_json::from_value(read_json(response).await?)
                .map_err(|_| "凭证响应格式错误")?;
            let credentials = decrypt_envelope(private, public.as_ref(), envelope)?;
            let sent = now_ms()?;
            let response = client
                .get(format!("{PROXY}/api/v5/public/time"))
                .send()
                .await
                .map_err(|_| "OKX 时间同步失败")?;
            let data = read_json(response).await?;
            let received = now_ms()?;
            let remote = data["data"][0]["ts"]
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("OKX 时间响应错误")?;
            let until = Instant::now() + Duration::from_secs(300);
            *guard = Some(Lease {
                identity,
                credentials,
                clock_offset: remote - (sent + received) / 2,
                until,
            });
            let storage = Arc::clone(&state.lease);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(300)).await;
                let mut guard = storage.lock().await;
                if guard.as_ref().is_some_and(|lease| lease.until == until) {
                    *guard = None;
                }
            });
        }
        let lease = guard.as_ref().ok_or("本地凭证不可用")?;
        (lease.credentials.clone(), lease.clock_offset)
    };
    for attempt in 0..3 {
        let result: Result<Value, String> = async {
            let clock = time::OffsetDateTime::from_unix_timestamp_nanos(
                (now_ms()? + offset) as i128 * 1_000_000,
            )
            .map_err(|_| "系统时间错误")?;
            let format = time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
            )
            .map_err(|_| "时间格式错误")?;
            let timestamp = clock.format(&format).map_err(|_| "时间格式错误")?;
            let mut request = client
                .get(format!("{PROXY}{path}"))
                .header("OK-ACCESS-KEY", &credentials.api_key)
                .header("OK-ACCESS-PASSPHRASE", &credentials.passphrase)
                .header("OK-ACCESS-TIMESTAMP", &timestamp)
                .header(
                    "OK-ACCESS-SIGN",
                    sign(&credentials.secret, &timestamp, &path),
                )
                .header("Cache-Control", "no-store");
            if credentials.demo {
                request = request.header("x-simulated-trading", "1");
            }
            let response = request
                .send()
                .await
                .map_err(|_| "Snippet 收益查询连接失败")?;
            let data = read_json(response).await?;
            if data["code"].as_str() == Some("50011") {
                return Err("OKX 请求限流".into());
            }
            if data["code"].as_str() != Some("0") || !data["data"].is_array() {
                return Err("OKX 收益查询失败，请稍后重试".into());
            }
            let account_id = STANDARD.encode(
                ring::digest::digest(
                    &ring::digest::SHA256,
                    format!("{}:{}", credentials.api_key, credentials.demo).as_bytes(),
                )
                .as_ref(),
            );
            Ok(json!({"rows": data["data"], "demo": credentials.demo, "account_id": account_id}))
        }
        .await;
        match result {
            Err(error) if attempt < 2 && retryable(&error) => {
                tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await
            }
            other => return other,
        }
    }
    Err("Snippet 收益查询失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_other_hosts_writes_and_unrestricted_parameters() {
        for path in [
            "https://other.example/api/v5/account/bills?instType=SWAP",
            "/api/v5/trade/order?instType=SWAP",
            "/api/v5/account/bills?instType=SWAP&end=1#x",
            "/api/v5/account/bills?instType=SWAP&foo=1",
            "/api/v5/account/bills?instType=SWAP&after=../x",
        ] {
            assert!(!allowed_path(path));
        }
        assert!(allowed_path(
            "/api/v5/account/bills-archive?instType=SWAP&limit=100&begin=1&end=3&after=123"
        ));
        for base in [
            "http://64.83.17.130:8002",
            "https://user@host",
            "https://host?token=x",
        ] {
            assert!(server_base(base).is_err());
        }
    }
    #[test]
    fn signs_exact_method_query_and_timestamp() {
        assert_eq!(
            sign(
                "test-secret",
                "2026-10-10T00:00:00.000Z",
                "/api/v5/account/bills?instType=SWAP&limit=100"
            ),
            "wGF89ap6vYCcuHJyO5CNeye1B5cIs97dqYlWXn8QndA="
        );
    }
    #[test]
    fn opens_python_server_envelope() {
        let Ok(python) = std::env::var("CYCLEPILOT_TEST_PYTHON") else {
            return;
        };
        let private = agreement::EphemeralPrivateKey::generate(
            &agreement::X25519,
            &rand::SystemRandom::new(),
        )
        .unwrap();
        let public = private.compute_public_key().unwrap();
        let output = std::process::Command::new(python).args(["-c",
            "import json,sys; from app.exchanges.desktop_credentials import seal_credentials; from app.exchanges.models import Credentials; print(json.dumps(seal_credentials(sys.argv[1], Credentials(api_key='synthetic-key',secret='synthetic-secret',passphrase='synthetic-pass',demo=True))))",
            &STANDARD.encode(public.as_ref())]).output().unwrap();
        assert!(output.status.success());
        let envelope = serde_json::from_slice(&output.stdout).unwrap();
        let credentials = decrypt_envelope(private, public.as_ref(), envelope).unwrap();
        assert_eq!(credentials.api_key, "synthetic-key");
        assert_eq!(credentials.secret, "synthetic-secret");
        assert!(credentials.demo);
    }
    #[test]
    #[ignore = "Read-only deployed server/Snippet smoke; requires a session token in environment"]
    fn deployed_snippet_read() {
        let base = std::env::var("CYCLEPILOT_SMOKE_BASE").unwrap();
        let token = std::env::var("CYCLEPILOT_SMOKE_TOKEN").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let state = OkxAnalyticsState::default();
            for route in [
                "/api/v5/account/bills",
                "/api/v5/account/bills-archive",
                "/api/v5/trade/fills-history",
            ] {
                let path = format!("{route}?instType=SWAP&limit=100");
                let result = read_analytics(base.clone(), token.clone(), path, &state).await;
                match result {
                    Ok(data) => println!(
                        "{route}: rows={}, demo={}",
                        data["rows"].as_array().unwrap().len(),
                        data["demo"]
                    ),
                    Err(error) => panic!("{route}: {error}"),
                }
            }
            assert!(state.lease.lock().await.is_some());
        });
    }

    #[test]
    #[ignore = "Private stdin/stdout bridge for read-only TypeScript analytics smoke"]
    fn analytics_rpc_probe() {
        use std::io::{BufRead, Write};
        let base = std::env::var("CYCLEPILOT_SMOKE_BASE").unwrap();
        let token = std::env::var("CYCLEPILOT_SMOKE_TOKEN").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let state = OkxAnalyticsState::default();
        for line in std::io::stdin().lock().lines() {
            let path: String = serde_json::from_str(&line.unwrap()).unwrap();
            let response =
                runtime.block_on(read_analytics(base.clone(), token.clone(), path, &state));
            let value = match response {
                Ok(data) => data,
                Err(error) => json!({"error": error}),
            };
            println!("CYCLEPILOT_JSON:{}", value);
            std::io::stdout().flush().unwrap();
        }
    }
}

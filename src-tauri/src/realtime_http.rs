//! Persistent HTTP pool for seconds-mode control and authoritative candles.
use reqwest::{Client, Method, Url};
use serde::Serialize;
use std::{collections::HashMap, time::Duration};

pub struct RealtimeHttpState {
    client: Client,
}
impl Default for RealtimeHttpState {
    fn default() -> Self {
        Self {
            client: Client::builder()
                // Keep warm connections, but don't multiplex control and market
                // traffic on a single HTTP/2 TCP stream during packet loss.
                .http1_only()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .pool_idle_timeout(Duration::from_secs(90))
                .build()
                .expect("seconds HTTP connection pool"),
        }
    }
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn target(base: &str, path: &str, method: &str) -> Result<(Url, Method, u64), String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 7
        || parts[0] != ""
        || parts[1..4] != ["api", "ai-trading", "tasks"]
        || parts[5] != "realtime"
    {
        return Err("不支持的秒级请求路径".into());
    }
    let id = parts[4].as_bytes();
    if id.len() != 36
        || !id.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err("无效的秒级任务编号".into());
    }
    let (expected, timeout) = match parts[6] {
        "seed" => ("GET", 90000),
        "candle" => ("GET", 1800),
        "heartbeat" => ("POST", 1800),
        "start" | "stop" => ("POST", 8000),
        "decision" => ("POST", 20000),
        _ => return Err("不支持的秒级请求操作".into()),
    };
    if method != expected {
        return Err("不支持的秒级请求方法".into());
    }
    let mut url = Url::parse(base).map_err(|_| "无效的服务器地址")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("无效的服务器地址".into());
    }
    url.set_path(&format!("{}{}", url.path().trim_end_matches('/'), path));
    Ok((
        url,
        Method::from_bytes(method.as_bytes()).map_err(|_| "无效的请求方法")?,
        timeout,
    ))
}

async fn send(
    state: &RealtimeHttpState,
    base: &str,
    path: &str,
    method: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let (url, method, timeout) = target(base, path, method)?;
    let mut request = state
        .client
        .request(method, url)
        .timeout(Duration::from_millis(timeout));
    for (name, value) in headers {
        if !["authorization", "content-type", "cache-control"]
            .contains(&name.to_ascii_lowercase().as_str())
        {
            return Err("不支持的秒级请求头".into());
        }
        request = request.header(&name, &value);
    }
    if let Some(body) = body {
        request = request.body(body)
    }
    let response = request.send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let body = response.text().await.map_err(network_error)?;
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}
fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "秒级服务器请求超时，停止续期".into()
    } else {
        "秒级服务器连接中断，停止续期".into()
    }
}

#[tauri::command]
pub async fn realtime_http_request(
    state: tauri::State<'_, RealtimeHttpState>,
    server_base: String,
    path: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    send(&state, &server_base, &path, &method, headers, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const TASK: &str = "/api/ai-trading/tasks/4dc5f123-cf27-445d-a980-ad7e3c543c65/realtime/";
    #[test]
    fn restricts_requests_to_the_seconds_api() {
        assert!(target("https://example.com", &format!("{TASK}heartbeat"), "POST").is_ok());
        for (base, path, method) in [
            (
                "https://user:secret@example.com",
                format!("{TASK}start"),
                "POST",
            ),
            ("https://example.com", "/api/live/orders".into(), "POST"),
            ("https://example.com", format!("{TASK}seed"), "POST"),
            ("https://example.com", format!("{TASK}../../orders"), "POST"),
        ] {
            assert!(target(base, &path, method).is_err());
        }
        assert_eq!(
            target("https://example.com", &format!("{TASK}candle"), "GET")
                .unwrap()
                .2,
            1800
        );
        assert_eq!(
            target("https://example.com", &format!("{TASK}heartbeat"), "POST")
                .unwrap()
                .2,
            1800
        );
    }
    #[test]
    fn reuses_one_tcp_connection_for_consecutive_requests() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            for _ in 0..2 {
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}").unwrap();
            }
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            // Local fixture must bypass this PC's system proxy.
            let state = RealtimeHttpState {
                client: Client::builder().no_proxy().build().unwrap(),
            };
            for _ in 0..2 {
                let response = send(
                    &state,
                    &base,
                    &format!("{TASK}seed"),
                    "GET",
                    HashMap::new(),
                    None,
                )
                .await
                .unwrap();
                assert_eq!(response.status, 200);
                assert_eq!(response.body, "{\"ok\":true}");
            }
        });
        server.join().unwrap();
    }
}

//! Public reverse-proxy channels. Never send repository tokens to mirrors.
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateChannels {
    next: AtomicU32,
    updates: Mutex<HashMap<u32, Update>>,
    bytes: Mutex<HashMap<u32, Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    rid: u32,
    current_version: String,
    version: String,
    body: Option<String>,
    date: Option<serde_json::Value>,
    raw_json: serde_json::Value,
}

const MIRRORS: [&str; 2] = ["https://gh-proxy.com/", "https://ghfast.top/"];
const MANIFEST: &str = "https://gist.githubusercontent.com/roberts9012062/373489c602619a435df63257d034849d/raw/latest.json";

fn mirror_url(url: &str, mirror: Option<&str>) -> Result<String, String> {
    match mirror {
        None => Ok(url.to_string()),
        Some(prefix)
            if MIRRORS.contains(&prefix)
                && url.starts_with(
                    "https://github.com/roberts9012062/ai-trading-desktop/releases/download/",
                ) =>
        {
            Ok(format!("{prefix}{url}"))
        }
        Some(_) => Err("更新镜像地址或安装包来源不受支持".into()),
    }
}

#[tauri::command]
pub async fn update_channel_check(
    app: AppHandle,
    state: State<'_, UpdateChannels>,
    endpoint: String,
    mirror: Option<String>,
    proxy: Option<String>,
) -> Result<Option<Metadata>, String> {
    let prefix = mirror.as_deref().unwrap_or("");
    if (!prefix.is_empty() && !MIRRORS.contains(&prefix))
        || !endpoint.starts_with(&format!("{prefix}{MANIFEST}?atd_check="))
    {
        return Err("不受支持的更新清单地址".into());
    }
    let mut builder = app
        .updater_builder()
        .clear_headers()
        .timeout(Duration::from_secs(12))
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(8))
                .read_timeout(Duration::from_secs(20))
        })
        .endpoints(vec![endpoint.parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?;
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy.parse().map_err(|e| format!("{e}"))?);
    } else {
        builder = builder.no_proxy();
    }
    let found = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(mut update) = found else {
        return Ok(None);
    };
    // Older public manifests used the asset API. Reconstruct the immutable public
    // release URL from the version instead of forwarding an Authorization token.
    if update.download_url.host_str() == Some("api.github.com")
        && update
            .download_url
            .path()
            .starts_with("/repos/roberts9012062/ai-trading-desktop/releases/assets/")
    {
        let v = &update.version;
        update.download_url = format!("https://github.com/roberts9012062/ai-trading-desktop/releases/download/v{v}/ai-trading-desktop_{v}_x64-setup.exe").parse().map_err(|e| format!("{e}"))?;
    }
    update.download_url = mirror_url(update.download_url.as_str(), mirror.as_deref())?
        .parse()
        .map_err(|e| format!("{e}"))?;
    update.timeout = Some(Duration::from_secs(180));
    let rid = state.next.fetch_add(1, Ordering::Relaxed);
    let metadata = Metadata {
        rid,
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        date: update.raw_json.get("pub_date").cloned(),
        raw_json: update.raw_json.clone(),
    };
    state
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .insert(rid, update);
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn update_channel_download(
    state: State<'_, UpdateChannels>,
    rid: u32,
    progress: Channel<serde_json::Value>,
) -> Result<(), String> {
    let update = state
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .get(&rid)
        .cloned()
        .ok_or("更新资源已关闭")?;
    let mut started = false;
    let bytes = update
        .download(
            |size, total| {
                if !started {
                    started = true;
                    let _ = progress.send(
                        serde_json::json!({"event":"Started","data":{"contentLength":total}}),
                    );
                }
                let _ = progress
                    .send(serde_json::json!({"event":"Progress","data":{"chunkLength":size}}));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Finished is emitted only after the official updater verifies the signature.
    let mut cache = state.bytes.lock().map_err(|e| e.to_string())?;
    if !state
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&rid)
    {
        return Err("更新资源已关闭".into());
    }
    cache.insert(rid, bytes);
    let _ = progress.send(serde_json::json!({"event":"Finished"}));
    Ok(())
}

#[tauri::command]
pub fn update_channel_install(state: State<'_, UpdateChannels>, rid: u32) -> Result<(), String> {
    let update = state
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .get(&rid)
        .cloned()
        .ok_or("更新资源已关闭")?;
    let bytes = state
        .bytes
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&rid)
        .ok_or("请先下载并验证更新包")?;
    update.install(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_channel_close(state: State<'_, UpdateChannels>, rid: u32) -> Result<(), String> {
    state.bytes.lock().map_err(|e| e.to_string())?.remove(&rid);
    state
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&rid);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_public_release_assets_are_mirrored() {
        let url = "https://github.com/roberts9012062/ai-trading-desktop/releases/download/v0.2.117/app.exe";
        assert_eq!(
            mirror_url(url, Some(MIRRORS[0])).unwrap(),
            format!("{}{url}", MIRRORS[0])
        );
        assert!(mirror_url("https://github.com.evil.invalid/package", Some(MIRRORS[0])).is_err());
        assert!(mirror_url(url, Some("https://unknown.invalid/")).is_err());
    }
}

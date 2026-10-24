use tauri::{AppHandle, Manager};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOGIN_RUN: OnceLock<String> = OnceLock::new();

/// A process-lifetime identifier, not an authentication token. Renderer reloads
/// share it; a new application process must confirm login again.
#[tauri::command]
pub fn desktop_login_session_id() -> String {
    LOGIN_RUN.get_or_init(|| {
        let started = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        format!("{}:{started}", std::process::id())
    }).clone()
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "主窗口不存在".into())
}

#[tauri::command]
pub fn desktop_minimize_window(app: AppHandle) -> Result<(), String> {
    main_window(&app)?.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_toggle_maximize(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize()
    } else {
        window.maximize()
    }.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_close_window(app: AppHandle) -> Result<(), String> {
    // Use the regular close request: existing task guards may prevent closing.
    main_window(&app)?.close().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn login_identifier_is_stable_across_renderer_requests_in_one_process() {
        let first = super::desktop_login_session_id();
        assert_eq!(first, super::desktop_login_session_id());
        assert!(first.starts_with(&format!("{}:", std::process::id())));
        assert!(!first.ends_with(':'));
    }
}

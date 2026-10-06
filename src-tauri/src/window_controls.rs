use tauri::{AppHandle, Manager};

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

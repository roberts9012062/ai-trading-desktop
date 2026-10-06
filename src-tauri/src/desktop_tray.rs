use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const TRAY_ID: &str = "cyclepilot-main";

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_hide_to_tray(app: AppHandle) -> Result<(), String> {
    // Never hide the only window unless a working restore entry has been created.
    if app.tray_by_id(TRAY_ID).is_none() {
        return Err("系统托盘初始化失败，请选择“正常最小化”".into());
    }
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    // Hide preserves the webview, login session, workers and native engine.
    window.hide().map_err(|e| e.to_string())
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", "收起到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("周期领航 · CyclePilot（点击显示窗口）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = restore(tray.app_handle()) {
                    tauri_plugin_log::log::warn!("托盘恢复窗口失败: {error}");
                }
            }
        })
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "tray-show" => restore(app),
                "tray-hide" => desktop_hide_to_tray(app.clone()),
                "tray-quit" => restore(app).and_then(|_| {
                    // Use the normal close path so active local mining tasks retain
                    // their existing close confirmation and engine cleanup.
                    app.get_webview_window("main")
                        .ok_or_else(|| "主窗口不存在".to_string())?
                        .close()
                        .map_err(|e| e.to_string())
                }),
                _ => Ok(()),
            };
            if let Err(error) = result {
                tauri_plugin_log::log::warn!("托盘操作失败: {error}");
            }
        });
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::include_image!("icons/32x32.png"));
    builder = builder.icon(icon);
    // Tauri's resource table retains the icon for the app lifetime.
    builder.build(app)?;
    Ok(())
}

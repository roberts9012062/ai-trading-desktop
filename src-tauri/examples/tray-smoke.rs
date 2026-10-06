//! Isolated native tray probe. No application boot, accounts or trading requests.
//! Set TRAY_SMOKE_URL to the loopback fixture and TRAY_SMOKE_DEBUG_PORT for CDP.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../src/desktop_tray.rs"]
mod desktop_tray;
#[path = "../src/window_controls.rs"]
mod window_controls;

#[tauri::command]
fn tray_smoke_remove_icon(app: tauri::AppHandle) {
    drop(app.remove_tray_by_id("cyclepilot-main"));
}

fn main() {
    let mut context = tauri::generate_context!();
    context.set_default_window_icon(Some(tauri::include_image!("icons/32x32.png")));
    let config = context.config_mut();
    config.identifier = "com.aitrading.desktop.tray-smoke".into();
    let fixture: tauri::Url = std::env::var("TRAY_SMOKE_URL")
        .expect("TRAY_SMOKE_URL")
        .parse()
        .unwrap();
    // Treat only this loopback fixture as the development app origin, so it
    // exercises the same custom-command IPC permissions as the real frontend.
    config.build.dev_url = Some(fixture.clone());
    let window = &mut config.app.windows[0];
    window.title = "CyclePilot · 托盘验收".into();
    window.url = tauri::WebviewUrl::External(fixture);
    window.data_directory = Some(
        std::env::current_dir()
            .unwrap()
            .join(".local-data/tray-smoke-webview"),
    );
    window.additional_browser_args = Some(format!(
        "{} --remote-debugging-port={}",
        window
            .additional_browser_args
            .as_deref()
            .unwrap_or_default(),
        std::env::var("TRAY_SMOKE_DEBUG_PORT").expect("TRAY_SMOKE_DEBUG_PORT"),
    ));
    tauri::Builder::default()
        .setup(|app| {
            desktop_tray::setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_tray::desktop_hide_to_tray,
            window_controls::desktop_minimize_window,
            window_controls::desktop_toggle_maximize,
            window_controls::desktop_close_window,
            tray_smoke_remove_icon
        ])
        .run(context)
        .expect("tray smoke application");
}

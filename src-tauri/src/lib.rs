use tauri::Manager;
mod native_engine;
mod update_channels;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Rust panic 落盘(release 为 panic=abort,hook 内同步写日志后退出)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = tauri_plugin_log::log::error!("PANIC: {info}");
        default_hook(info);
    }));

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .manage(native_engine::NativeEngineState::default())
        .manage(update_channels::UpdateChannels::default())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            native_engine::native_engine_spawn,
            native_engine::native_engine_status,
            native_engine::native_engine_kill,
            update_channels::update_channel_check,
            update_channels::update_channel_download,
            update_channels::update_channel_install,
            update_channels::update_channel_close,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = native_engine::shutdown(window.app_handle());
            }
        })
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets(vec![
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("ai-trading-desktop".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

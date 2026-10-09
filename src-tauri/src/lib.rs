use tauri::Manager;
mod native_engine;
mod update_channels;
mod desktop_tray;
mod window_controls;
mod okx_analytics;

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
        let _ = desktop_tray::restore(app);
    }));
    builder
        .setup(|app| {
            if let Err(error) = desktop_tray::setup(app.handle()) {
                tauri_plugin_log::log::warn!("系统托盘初始化失败: {error}");
            }
            Ok(())
        })
        .manage(native_engine::NativeEngineState::default())
        .manage(update_channels::UpdateChannels::default())
        .manage(okx_analytics::OkxAnalyticsState::default())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_tray::desktop_hide_to_tray,
            window_controls::desktop_minimize_window,
            window_controls::desktop_toggle_maximize,
            window_controls::desktop_close_window,
            okx_analytics::okx_analytics_read,
            okx_analytics::okx_analytics_clear,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Rust panic 落盘(release 为 panic=abort,hook 内同步写日志后退出)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = tauri_plugin_log::log::error!("PANIC: {info}");
        default_hook(info);
    }));

    tauri::Builder::default()
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

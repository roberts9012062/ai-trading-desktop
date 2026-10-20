use tauri::Manager;
mod native_engine;
mod update_channels;
mod desktop_tray;
mod window_controls;
mod okx_analytics;
mod realtime_http;
mod market_data;
mod export_file;
mod local_store;
mod local_exchange;
mod execution_worker;
mod execution_preparation;
mod execution_runtime;
mod execution_snapshot;

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
        .manage(realtime_http::RealtimeHttpState::default())
        .manage(market_data::MarketDataState::default())
        .manage(local_store::LocalStoreState::default())
        .manage(execution_runtime::ExecutionRuntime::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            export_file::desktop_save_export,
            desktop_tray::desktop_hide_to_tray,
            window_controls::desktop_minimize_window,
            window_controls::desktop_toggle_maximize,
            window_controls::desktop_close_window,
            okx_analytics::okx_analytics_read,
            okx_analytics::collection_analytics_read,
            okx_analytics::okx_analytics_clear,
            realtime_http::realtime_http_request,
            market_data::collection_key,
            market_data::collection_http,
            local_store::desktop_db,
            local_exchange::desktop_local_exchange,
            local_exchange::desktop_credential_import,
            execution_runtime::desktop_executor_context,
            execution_runtime::desktop_executor_prepare,
            execution_runtime::desktop_executor_start,
            execution_runtime::desktop_executor_status,
            execution_runtime::desktop_executor_snapshot,
            execution_runtime::desktop_executor_stop,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app,event| {
            if let tauri::RunEvent::ExitRequested {api,..}=event {
                let state=app.state::<execution_runtime::ExecutionRuntime>();
                if !state.exit_ready.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    if state.exit_draining.swap(true,std::sync::atomic::Ordering::SeqCst){return;}
                    let app=app.clone();
                    tauri::async_runtime::spawn(async move {
                        if execution_runtime::shutdown(&app).await.is_err(){
                            tauri_plugin_log::log::warn!("独立执行器退出未确认，已保留待对账状态");
                        }
                        app.state::<execution_runtime::ExecutionRuntime>().exit_ready.store(true,std::sync::atomic::Ordering::SeqCst);
                        app.exit(0);
                    });
                }
            }
        })
}

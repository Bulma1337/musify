use tauri::Manager;

mod audio;
mod db;
mod downloads;
mod secrets;
mod stats;

/// Basic build information shown in Settings → About.
#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    version: String,
    identifier: String,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let config = app.config();
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        identifier: config.identifier.clone(),
    }
}

/// Brings the main window to the front, e.g. when a second instance is started.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be registered first so a second launch only focuses the running instance.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                focus_main_window(app);
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        // Covers saved with downloaded albums, for browsing offline.
        .register_asynchronous_uri_scheme_protocol("navdl", |ctx, request, responder| {
            downloads::serve_cover(ctx.app_handle(), request, responder);
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(audio::AudioState::new(app.handle()));
            app.manage(db::DbState(db::open_app_db(app.handle())));
            app.manage(downloads::DownloadsState::new(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            audio::audio_send,
            audio::audio_subscribe,
            audio::audio_spectrum_subscribe,
            audio::audio_devices,
            audio::audio_eq_response,
            audio::audio_parse_autoeq,
            stats::history_record,
            stats::stats_summary,
            stats::stats_tracks,
            stats::stats_years,
            stats::save_png,
            audio::audio_cache_info,
            audio::audio_cache_set_limit,
            audio::audio_cache_clear,
            downloads::downloads_subscribe,
            downloads::downloads_list,
            downloads::downloads_enqueue,
            downloads::downloads_set_collection,
            downloads::downloads_remove_collection,
            downloads::downloads_remove_track,
            downloads::downloads_cancel,
            downloads::downloads_remove_all,
            downloads::downloads_storage_info,
            downloads::downloads_set_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Navify");
}

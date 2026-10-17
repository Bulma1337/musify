use tauri::Manager;

mod audio;
mod db;
mod discord;
mod downloads;
mod media;
mod migrate;
mod secrets;
mod stats;
mod tray;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate::move_old_data();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be registered first so a second launch only focuses the running instance.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                tray::show_main_window(app);
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
            app.manage(media::MediaState::start(app.handle()));
            app.manage(discord::DiscordState::start());
            app.manage(tray::create(app.handle())?);
            // Started by autostart: stay in the tray until the user opens the window.
            if std::env::args().any(|a| a == "--minimized")
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.hide();
            }
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
            media::media_track,
            media::media_playback,
            media::media_clear,
            tray::tray_update,
            discord::discord_presence,
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
            downloads::downloads_set_dir,
            downloads::downloads_lyrics_read,
            downloads::downloads_lyrics_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running Musify");
}

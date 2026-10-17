//! Offline downloads: a queue with resume and retries, the file layout, the database bookkeeping
//! and the Tauri commands the frontend uses.
//!
//! Stream URLs and headers (which carry credentials) come from the frontend per job and live in
//! memory only. After a restart unfinished rows stay `queued`; the frontend resolves their sources
//! again and hands them over (`downloads_enqueue`).

pub mod manager;
mod paths;
mod storage;
mod store;
mod transfer;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, UriSchemeResponder};

use crate::db::{self, DbState};
use manager::{DownloadUpdate, EnqueueJob, Listing, Manager, RetryPolicy};
use store::{CollectionInput, TrackKey};

/// Managed state: `State<'_, DownloadsState>` in commands.
pub struct DownloadsState {
    manager: Arc<Manager>,
}

impl DownloadsState {
    pub fn new(app: &AppHandle) -> Self {
        let db = Arc::clone(&app.state::<DbState>().0);
        let default_dir = app
            .path()
            .app_local_data_dir()
            .map(|d| d.join("downloads"))
            .unwrap_or_else(|_| std::env::temp_dir().join("musify-downloads"));
        let dir = db
            .with(|c| store::get_setting(c, store::SETTING_DIR))
            .ok()
            .flatten()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_dir);
        Self {
            manager: Arc::new(Manager::new(db, dir, RetryPolicy::default())),
        }
    }
}

/// Runs blocking manager work off the async runtime.
async fn blocking<T: Send + 'static>(
    state: &DownloadsState,
    f: impl FnOnce(&Manager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = Arc::clone(&state.manager);
    tauri::async_runtime::spawn_blocking(move || f(&manager))
        .await
        .map_err(|e| e.to_string())?
}

/// Sends progress and state changes (batched, about ten times per second) until the webview
/// subscribes again.
#[tauri::command]
pub fn downloads_subscribe(
    state: tauri::State<'_, DownloadsState>,
    on_update: Channel<Vec<DownloadUpdate>>,
) {
    state.manager.set_sink(Arc::new(move |batch| {
        let _ = on_update.send(batch);
    }));
}

#[tauri::command]
pub async fn downloads_list(
    state: tauri::State<'_, DownloadsState>,
    server_id: String,
) -> Result<Listing, String> {
    blocking(&state, move |m| m.list(&server_id)).await
}

#[tauri::command]
pub async fn downloads_enqueue(
    state: tauri::State<'_, DownloadsState>,
    jobs: Vec<EnqueueJob>,
) -> Result<(), String> {
    blocking(&state, move |m| m.enqueue(jobs)).await
}

/// Registers an album, playlist or the favorites, queues its tracks and removes files of tracks
/// that dropped out of it.
#[tauri::command]
pub async fn downloads_set_collection(
    state: tauri::State<'_, DownloadsState>,
    collection: CollectionInput,
    jobs: Vec<EnqueueJob>,
) -> Result<(), String> {
    blocking(&state, move |m| m.set_collection(collection, jobs)).await
}

#[tauri::command]
pub async fn downloads_remove_collection(
    state: tauri::State<'_, DownloadsState>,
    server_id: String,
    kind: String,
    item_id: String,
) -> Result<(), String> {
    blocking(&state, move |m| {
        m.remove_collection(&server_id, &kind, &item_id)
    })
    .await
}

/// Undoes an individual download. Returns false when the track is kept because a downloaded album,
/// playlist or the favorites still contain it.
#[tauri::command]
pub async fn downloads_remove_track(
    state: tauri::State<'_, DownloadsState>,
    server_id: String,
    track_id: String,
) -> Result<bool, String> {
    blocking(&state, move |m| {
        m.remove_individual(&TrackKey::new(server_id, track_id))
    })
    .await
}

/// Stops and deletes the given downloads whatever collection they belong to (cancel / clean up).
#[tauri::command]
pub async fn downloads_cancel(
    state: tauri::State<'_, DownloadsState>,
    server_id: String,
    track_ids: Vec<String>,
) -> Result<(), String> {
    blocking(&state, move |m| {
        let keys: Vec<TrackKey> = track_ids
            .into_iter()
            .map(|id| TrackKey::new(&server_id, id))
            .collect();
        m.remove_tracks(&keys)
    })
    .await
}

#[tauri::command]
pub async fn downloads_remove_all(state: tauri::State<'_, DownloadsState>) -> Result<(), String> {
    blocking(&state, |m| m.remove_all()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub dir: String,
    /// Size of finished downloads plus partial files.
    pub downloads_bytes: u64,
    pub track_count: u64,
    pub busy: bool,
}

#[tauri::command]
pub async fn downloads_storage_info(
    state: tauri::State<'_, DownloadsState>,
) -> Result<StorageInfo, String> {
    let manager = Arc::clone(&state.manager);
    let (done_bytes, track_count) = db::run(manager.db(), |c| {
        Ok((store::downloaded_bytes(c)?, store::count_done(c)?))
    })
    .await?;
    let dir = manager.dir();
    let partial = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            storage::dir_size(&dir.join(paths::PARTIAL_DIR))
        })
        .await
        .map_err(|e| e.to_string())?
    };
    Ok(StorageInfo {
        dir: dir.to_string_lossy().into_owned(),
        downloads_bytes: done_bytes + partial,
        track_count,
        busy: manager.is_busy(),
    })
}

/// Moves the downloads folder, reporting progress (at most about ten messages per second).
#[tauri::command]
pub async fn downloads_set_dir(
    state: tauri::State<'_, DownloadsState>,
    dir: String,
    on_progress: Channel<storage::MoveProgress>,
) -> Result<(), String> {
    blocking(&state, move |m| {
        let mut last = Instant::now() - Duration::from_secs(1);
        m.move_folder(std::path::Path::new(&dir), &mut |progress| {
            if progress.done || last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(progress);
            }
        })
    })
    .await
}

// --- Cover images of downloaded albums -----------------------------------------------------------

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn image_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

fn cover_response(manager: &Manager, request_path: &str) -> Response<Vec<u8>> {
    let respond = |status: StatusCode, body: Vec<u8>, mime: &str| {
        Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "max-age=3600")
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    };
    let decoded = percent_decode(request_path.trim_start_matches('/'));
    let Some((server_id, cover_ref)) = decoded.split_once('/') else {
        return respond(StatusCode::BAD_REQUEST, Vec::new(), "text/plain");
    };
    let rel = manager
        .db()
        .with(|c| store::get_cover_path(c, server_id, cover_ref))
        .ok()
        .flatten();
    let file = rel.and_then(|rel| paths::from_db_path(&manager.dir(), &rel));
    match file.and_then(|file| {
        std::fs::read(&file)
            .ok()
            .map(|bytes| (bytes, image_mime(&file)))
    }) {
        Some((bytes, mime)) => respond(StatusCode::OK, bytes, mime),
        None => respond(StatusCode::NOT_FOUND, Vec::new(), "text/plain"),
    }
}

/// `navdl://localhost/<server id>/<cover ref>` (percent-encoded as one path segment): the cover
/// image saved with a downloaded album, for browsing offline.
pub fn serve_cover(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let manager = Arc::clone(&app.state::<DownloadsState>().manager);
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(cover_response(&manager, &path));
    });
}

#[cfg(test)]
mod tests;

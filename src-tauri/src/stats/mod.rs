//! Listening history and statistics: recording plays, queries for the Stats page, the automatic
//! playlists and the yearly Recap, and saving the Recap images.
//!
//! Every command that touches the database is `async` and goes through [`crate::db::run`].

mod queries;

use std::path::Path;

use tauri::State;

use crate::db::{self, DbState};
use queries::{NewPlay, StatRow, Summary, TrackListKind};

/// Records one finished playback. Called fire-and-forget by the frontend.
#[tauri::command]
pub async fn history_record(db: State<'_, DbState>, play: NewPlay) -> Result<(), String> {
    db::run(&db.0, move |conn| queries::insert_play(conn, &play)).await
}

/// Everything the Stats page and the Recap need for `[from_ms, to_ms)` in one round trip.
#[tauri::command]
pub async fn stats_summary(
    db: State<'_, DbState>,
    server_id: String,
    from_ms: i64,
    to_ms: i64,
    top_limit: u32,
) -> Result<Summary, String> {
    db::run(&db.0, move |conn| {
        queries::summary(conn, &server_id, from_ms, to_ms, i64::from(top_limit))
    })
    .await
}

/// Ranked local tracks for an automatic playlist (see [`TrackListKind`]).
#[tauri::command]
pub async fn stats_tracks(
    db: State<'_, DbState>,
    server_id: String,
    kind: TrackListKind,
    now_ms: i64,
    from_ms: i64,
    to_ms: i64,
    limit: u32,
) -> Result<Vec<StatRow>, String> {
    db::run(&db.0, move |conn| {
        queries::track_list(
            conn,
            &server_id,
            kind,
            now_ms,
            from_ms,
            to_ms,
            i64::from(limit),
        )
    })
    .await
}

/// Calendar years (local time) with listening history, ascending.
#[tauri::command]
pub async fn stats_years(db: State<'_, DbState>, server_id: String) -> Result<Vec<i32>, String> {
    db::run(&db.0, move |conn| queries::years(conn, &server_id)).await
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;

/// Writes a Recap image to the path the user picked in the save dialog. The frontend sends the
/// PNG as the raw request body and the path, percent-encoded, in the `x-path` header (raw
/// bodies avoid the JSON blow-up of a byte array).
///
/// This is a file write chosen by the webview, so it is deliberately narrow: only absolute `.png`
/// paths, and only data that really is a PNG.
#[tauri::command]
pub async fn save_png(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image as raw bytes".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing x-path header")?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || write_png(Path::new(&path), &bytes))
        .await
        .map_err(|e| e.to_string())?
}

fn write_png(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("the path must be absolute".into());
    }
    let is_png = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if !is_png {
        return Err("only .png files can be saved".into());
    }
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("the data is not a PNG image".into());
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err("the image is too large".into());
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

/// Decodes `%XX` escapes (as produced by `encodeURIComponent`); invalid escapes stay as they are.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_dir() -> std::path::PathBuf {
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("stats-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png() -> Vec<u8> {
        let mut data = PNG_MAGIC.to_vec();
        data.extend_from_slice(&[0; 16]);
        data
    }

    #[test]
    fn writes_a_png_to_an_absolute_path() {
        let path = target_dir().join("ok.png");
        let _ = std::fs::remove_file(&path);
        write_png(&path, &png()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), png());
    }

    #[test]
    fn rejects_other_data_extensions_and_relative_paths() {
        let dir = target_dir();
        assert!(write_png(&dir.join("x.png"), b"not a png").is_err());
        assert!(write_png(&dir.join("x.exe"), &png()).is_err());
        assert!(write_png(&dir.join("x"), &png()).is_err());
        assert!(write_png(Path::new("relative.png"), &png()).is_err());
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(
            percent_decode("C%3A%5CUsers%5CJos%C3%A9%5Crecap%202026.png"),
            "C:\\Users\\José\\recap 2026.png"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }
}

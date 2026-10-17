//! System media controls: the Windows media overlay (SMTC) with title, artist and cover, and the
//! keyboard media keys (play/pause, next, previous), which Windows routes to the active session.
//! macOS (Now Playing) and Linux (MPRIS) come for free through the same crate.
//!
//! The controls live on their own thread (the platform objects are not `Send`); commands reach it
//! over a channel. Button presses are emitted to the frontend as `media-control` events.

use std::path::PathBuf;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{Emitter, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    title: String,
    artist: String,
    album: Option<String>,
    duration_ms: Option<u64>,
    /// Cover image URL. Fetched here and handed to the OS as a local file; the URL itself (it may
    /// carry credentials) is never stored or logged.
    cover_url: Option<String>,
    #[serde(default)]
    allow_insecure_tls: bool,
}

enum Command {
    Track(TrackInfo),
    Playback {
        playing: bool,
        position_ms: Option<u64>,
    },
    Clear,
}

/// What a media button asks for, sent to the frontend.
#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Action {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
    /// Absolute position in ms.
    SeekTo {
        position_ms: u64,
    },
    /// Relative jump in ms (negative = back).
    SeekBy {
        offset_ms: i64,
    },
}

pub struct MediaState {
    tx: Sender<Command>,
}

impl MediaState {
    pub fn start(app: &tauri::AppHandle) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("media-controls".into())
            .spawn(move || run(app, rx));
        Self { tx }
    }
}

fn cover_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("media-cover.img"))
}

/// Downloads the cover to the cache file and returns its `file://` URL.
fn fetch_cover(app: &tauri::AppHandle, url: &str, insecure: bool) -> Option<String> {
    let client = musify_audio::source::build_http_client(insecure).ok()?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().ok()?;
    let path = cover_path(app)?;
    std::fs::write(&path, &bytes).ok()?;
    let path = path.to_string_lossy().replace('\\', "/");
    Some(format!("file:///{}", path.trim_start_matches('/')))
}

fn run(app: tauri::AppHandle, rx: Receiver<Command>) {
    #[cfg(windows)]
    let hwnd = {
        let Some(window) = app.get_webview_window("main") else {
            log::warn!("media controls: no main window");
            return;
        };
        match window.hwnd() {
            Ok(hwnd) => Some(hwnd.0),
            Err(e) => {
                log::warn!("media controls: no window handle: {e}");
                return;
            }
        }
    };
    #[cfg(not(windows))]
    let hwnd = None;

    let config = PlatformConfig {
        dbus_name: "musify",
        display_name: "Musify",
        hwnd,
    };
    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("media controls unavailable: {e:?}");
            return;
        }
    };
    let events = app.clone();
    let attached = controls.attach(move |event: MediaControlEvent| {
        let action = match event {
            MediaControlEvent::Play => Action::Play,
            MediaControlEvent::Pause => Action::Pause,
            MediaControlEvent::Toggle => Action::Toggle,
            MediaControlEvent::Next => Action::Next,
            MediaControlEvent::Previous => Action::Previous,
            MediaControlEvent::Stop => Action::Stop,
            MediaControlEvent::SetPosition(MediaPosition(position)) => Action::SeekTo {
                position_ms: position.as_millis() as u64,
            },
            MediaControlEvent::SeekBy(direction, by) => {
                let ms = by.as_millis() as i64;
                Action::SeekBy {
                    offset_ms: if matches!(direction, souvlaki::SeekDirection::Backward) {
                        -ms
                    } else {
                        ms
                    },
                }
            }
            _ => return,
        };
        let _ = events.emit("media-control", action);
    });
    if let Err(e) = attached {
        log::warn!("media controls: cannot attach: {e:?}");
        return;
    }

    while let Ok(command) = rx.recv() {
        let result = match command {
            Command::Track(info) => {
                let cover = info
                    .cover_url
                    .as_deref()
                    .and_then(|url| fetch_cover(&app, url, info.allow_insecure_tls));
                controls.set_metadata(MediaMetadata {
                    title: Some(&info.title),
                    artist: Some(&info.artist),
                    album: info.album.as_deref(),
                    cover_url: cover.as_deref(),
                    duration: info.duration_ms.map(Duration::from_millis),
                })
            }
            Command::Playback {
                playing,
                position_ms,
            } => {
                let progress = position_ms.map(|ms| MediaPosition(Duration::from_millis(ms)));
                controls.set_playback(if playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                })
            }
            Command::Clear => controls.set_playback(MediaPlayback::Stopped),
        };
        if let Err(e) = result {
            log::debug!("media controls update failed: {e:?}");
        }
    }
}

/// The track shown in the system media overlay changed.
#[tauri::command]
pub fn media_track(state: tauri::State<'_, MediaState>, track: TrackInfo) {
    let _ = state.tx.send(Command::Track(track));
}

/// Play/pause state and position (the overlay keeps counting on its own while playing).
#[tauri::command]
pub fn media_playback(
    state: tauri::State<'_, MediaState>,
    playing: bool,
    position_ms: Option<u64>,
) {
    let _ = state.tx.send(Command::Playback {
        playing,
        position_ms,
    });
}

/// Nothing is loaded any more.
#[tauri::command]
pub fn media_clear(state: tauri::State<'_, MediaState>) {
    let _ = state.tx.send(Command::Clear);
}

//! Tauri bridge to the native audio engine (`navify-audio`): commands from the UI, events and
//! spectrum frames to the UI over IPC channels.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use navify_audio::api::{
    DeviceInfo, EngineCommand, EngineEvent, EqConfig, EqResponse, SpectrumFrame,
};
use navify_audio::source::CacheConfig;
use navify_audio::{AudioEngine, EngineInit};
use tauri::Manager;
use tauri::ipc::Channel;

/// Size of the streaming cache until the frontend applies the user's setting.
const DEFAULT_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Bounds for the configurable cache size.
const MIN_CACHE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

pub struct AudioState {
    engine: Arc<AudioEngine>,
    /// Incremented per subscription, so a reloaded webview replaces the previous forwarder.
    event_generation: Arc<AtomicU64>,
    spectrum_generation: Arc<AtomicU64>,
    cache_limit: Arc<AtomicU64>,
}

impl AudioState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_cache_dir()
            .map(|d| d.join("audio-cache"))
            .unwrap_or_else(|_| std::env::temp_dir().join("navify-audio-cache"));
        let engine = AudioEngine::new(EngineInit::with_devices(CacheConfig {
            dir,
            max_bytes: DEFAULT_CACHE_BYTES,
        }));
        Self {
            engine: Arc::new(engine),
            event_generation: Arc::new(AtomicU64::new(0)),
            spectrum_generation: Arc::new(AtomicU64::new(0)),
            cache_limit: Arc::new(AtomicU64::new(DEFAULT_CACHE_BYTES)),
        }
    }
}

#[tauri::command]
pub fn audio_send(state: tauri::State<'_, AudioState>, command: EngineCommand) {
    state.engine.send(command);
}

/// Forwards engine events to the webview until a newer subscription replaces this one.
#[tauri::command]
pub fn audio_subscribe(state: tauri::State<'_, AudioState>, on_event: Channel<EngineEvent>) {
    let generation = state.event_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.event_generation.clone();
    let events = state.engine.events();
    std::thread::Builder::new()
        .name("navify-audio-events".into())
        .spawn(move || {
            while current.load(Ordering::SeqCst) == generation {
                match events.recv_timeout(std::time::Duration::from_millis(250)) {
                    Ok(event) => {
                        if on_event.send(event).is_err() {
                            break;
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .expect("spawn audio event forwarder");
}

/// Forwards analyzer frames while the EQ view is open (enable with `SetSpectrum`).
#[tauri::command]
pub fn audio_spectrum_subscribe(
    state: tauri::State<'_, AudioState>,
    on_frame: Channel<SpectrumFrame>,
) {
    let generation = state.spectrum_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.spectrum_generation.clone();
    let frames = state.engine.spectrum();
    std::thread::Builder::new()
        .name("navify-audio-spectrum".into())
        .spawn(move || {
            while current.load(Ordering::SeqCst) == generation {
                match frames.recv_timeout(std::time::Duration::from_millis(250)) {
                    Ok(frame) => {
                        if on_frame.send(frame).is_err() {
                            break;
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .expect("spawn audio spectrum forwarder");
}

#[tauri::command]
pub fn audio_devices(state: tauri::State<'_, AudioState>) -> Vec<DeviceInfo> {
    state.engine.list_devices()
}

#[tauri::command]
pub fn audio_eq_response(
    state: tauri::State<'_, AudioState>,
    config: EqConfig,
    points: usize,
) -> EqResponse {
    state.engine.eq_response(&config, points.clamp(16, 2048))
}

#[tauri::command]
pub fn audio_parse_autoeq(text: String) -> Result<EqConfig, String> {
    navify_audio::dsp::parse_autoeq(&text).map_err(|e| e.to_string())
}

/// Size and limit of the streaming cache (not the downloads).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub size_bytes: u64,
    pub limit_bytes: u64,
}

#[tauri::command]
pub async fn audio_cache_info(state: tauri::State<'_, AudioState>) -> Result<CacheInfo, String> {
    let engine = state.engine.clone();
    let limit_bytes = state.cache_limit.load(Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || CacheInfo {
        size_bytes: engine.cache_size(),
        limit_bytes,
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sets the cache limit; entries over the new limit are evicted right away (oldest first).
#[tauri::command]
pub async fn audio_cache_set_limit(
    state: tauri::State<'_, AudioState>,
    max_bytes: u64,
) -> Result<(), String> {
    let max_bytes = max_bytes.clamp(MIN_CACHE_BYTES, MAX_CACHE_BYTES);
    state.cache_limit.store(max_bytes, Ordering::Relaxed);
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.set_cache_limit(max_bytes))
        .await
        .map_err(|e| e.to_string())
}

/// Deletes all cached streams except the ones playing right now.
#[tauri::command]
pub async fn audio_cache_clear(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.clear_cache())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

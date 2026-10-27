//! Tauri bridge to network speakers (`musify-cast`): the on/off switch, scans, the device list, and
//! one playback session at a time whose events reach the player like the local engine's.
//!
//! Everything starts switched off. Only `network_set_enabled` (the user's setting) opens the gate;
//! nothing received from the network can.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use musify_audio::api::EngineEvent;
use musify_cast::connect::{SessionInfo, connect};
use musify_cast::discovery::{SCAN_TIME, lan_client, scan};
use musify_cast::session::{EndReason, RemoteCommand, Session, SessionEvent};
use musify_cast::{FoundDevice, NetGate, NetworkDevice};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;

/// How long switching back (or turning off) waits for the device to stop.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
/// A device missing from this many scans in a row leaves the list.
const MISSED_SCANS: u64 = 2;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NetworkEvent {
    Devices { devices: Vec<NetworkDevice> },
    Scanning { active: bool },
    /// Playback events of the session, in the local engine's format.
    Engine { event: EngineEvent },
    SessionEnded { reason: EndReason },
}

struct Known {
    device: FoundDevice,
    last_scan: u64,
}

struct Active {
    id: u64,
    session: Session,
}

#[derive(Default)]
struct Shared {
    subscriber: Mutex<Option<Channel<NetworkEvent>>>,
    devices: Mutex<HashMap<String, Known>>,
    active: Mutex<Option<Active>>,
}

impl Shared {
    fn emit(&self, event: NetworkEvent) {
        if let Some(channel) = self.subscriber.lock().as_ref() {
            let _ = channel.send(event);
        }
    }

    fn device_list(&self) -> Vec<NetworkDevice> {
        let mut list: Vec<NetworkDevice> = self
            .devices
            .lock()
            .values()
            .map(|k| k.device.device.clone())
            .collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        list
    }

    fn emit_devices(&self) {
        self.emit(NetworkEvent::Devices {
            devices: self.device_list(),
        });
    }

    /// Ends the active session, if any (outside the lock: closing waits for its thread).
    fn close_session(&self) {
        let active = self.active.lock().take();
        if let Some(active) = active {
            active.session.close(CLOSE_TIMEOUT);
        }
    }
}

pub struct NetworkState {
    gate: Arc<NetGate>,
    shared: Arc<Shared>,
    scanning: Arc<AtomicBool>,
    scans: Arc<AtomicU64>,
    sessions: AtomicU64,
}

impl NetworkState {
    pub fn new() -> Self {
        Self {
            gate: Arc::new(NetGate::new()),
            shared: Arc::new(Shared::default()),
            scanning: Arc::new(AtomicBool::new(false)),
            scans: Arc::new(AtomicU64::new(0)),
            sessions: AtomicU64::new(0),
        }
    }
}

/// Receives device lists and session events until a newer subscription replaces this one.
#[tauri::command]
pub fn network_subscribe(state: tauri::State<'_, NetworkState>, on_event: Channel<NetworkEvent>) {
    *state.shared.subscriber.lock() = Some(on_event);
    state.shared.emit_devices();
}

/// The user's setting. Off ends any session (the device is told to stop first), forgets all
/// devices and closes the gate, so no socket is created until it is switched on again.
#[tauri::command]
pub async fn network_set_enabled(
    state: tauri::State<'_, NetworkState>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        state.gate.set_open(true);
        return Ok(());
    }
    let gate = state.gate.clone();
    let shared = state.shared.clone();
    tauri::async_runtime::spawn_blocking(move || {
        shared.close_session();
        gate.set_open(false);
        shared.devices.lock().clear();
        shared.emit_devices();
    })
    .await
    .map_err(|e| e.to_string())
}

/// Looks for devices for a few seconds; the list arrives as `Devices` events.
#[tauri::command]
pub fn network_scan(state: tauri::State<'_, NetworkState>) -> Result<(), String> {
    state.gate.check().map_err(|e| e.to_string())?;
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let gate = state.gate.clone();
    let shared = state.shared.clone();
    let scanning = state.scanning.clone();
    let scan_number = state.scans.fetch_add(1, Ordering::SeqCst) + 1;
    let spawned = std::thread::Builder::new()
        .name("musify-cast-scan".into())
        .spawn(move || {
            shared.emit(NetworkEvent::Scanning { active: true });
            let result = lan_client().map_err(std::io::Error::other).and_then(|client| {
                scan(&gate, &client, SCAN_TIME, &mut |found| {
                    let id = found.device.id.clone();
                    shared.devices.lock().insert(
                        id,
                        Known {
                            device: found,
                            last_scan: scan_number,
                        },
                    );
                    shared.emit_devices();
                })
            });
            if let Err(e) = result {
                log::info!("network speakers: scan failed: {e}");
            }
            if gate.is_open() {
                shared
                    .devices
                    .lock()
                    .retain(|_, known| known.last_scan + MISSED_SCANS > scan_number);
            } else {
                shared.devices.lock().clear();
            }
            shared.emit_devices();
            shared.emit(NetworkEvent::Scanning { active: false });
            scanning.store(false, Ordering::SeqCst);
        });
    if let Err(e) = spawned {
        state.scanning.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }
    Ok(())
}

/// Connects to a listed device and starts a session on it (replacing any previous one).
#[tauri::command]
pub async fn network_connect(
    state: tauri::State<'_, NetworkState>,
    device_id: String,
) -> Result<SessionInfo, String> {
    state.gate.check().map_err(|e| e.to_string())?;
    let found = state
        .shared
        .devices
        .lock()
        .get(&device_id)
        .map(|k| k.device.clone())
        .ok_or_else(|| "unknown device".to_string())?;
    let gate = state.gate.clone();
    let shared = state.shared.clone();
    let id = state.sessions.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        shared.close_session();
        let connected = connect(&gate, &found)?;
        let sink_shared = Arc::downgrade(&shared);
        let session = Session::start(
            connected.renderer,
            Box::new(connected.host),
            gate,
            Box::new(move |event| {
                let Some(shared) = sink_shared.upgrade() else { return };
                match event {
                    SessionEvent::Engine(event) => shared.emit(NetworkEvent::Engine { event }),
                    SessionEvent::Ended(reason) => {
                        let mut active = shared.active.lock();
                        if active.as_ref().is_some_and(|a| a.id == id) {
                            *active = None;
                        }
                        drop(active);
                        shared.emit(NetworkEvent::SessionEnded { reason });
                    }
                }
            }),
        )
        .map_err(|e| e.to_string())?;
        *shared.active.lock() = Some(Active { id, session });
        Ok(connected.info)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops playback on the device and ends the session (back to this computer).
#[tauri::command]
pub async fn network_disconnect(state: tauri::State<'_, NetworkState>) -> Result<(), String> {
    let shared = state.shared.clone();
    tauri::async_runtime::spawn_blocking(move || shared.close_session())
        .await
        .map_err(|e| e.to_string())
}

/// A playback command for the active session (ignored without one).
#[tauri::command]
pub fn network_send(state: tauri::State<'_, NetworkState>, command: RemoteCommand) {
    if let Some(active) = state.shared.active.lock().as_ref() {
        active.session.send(command);
    }
}

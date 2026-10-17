//! Device enumeration/lookup and default-device change detection.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::str::FromStr;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use crossbeam_channel::{RecvTimeoutError, Sender};
use parking_lot::Mutex;

use super::{OutputError, OutputEvent};
use crate::api::{DeviceInfo, OutputConfig};

/// How often the watcher compares the system default device.
const WATCH_INTERVAL: Duration = Duration::from_millis(1000);

/// Runs `f`, turning a panic inside a backend (cpal `expect`s on some property reads) into `None`.
fn guarded<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok().flatten()
}

pub(crate) fn device_name(device: &cpal::Device) -> String {
    guarded(|| device.description().ok().map(|d| d.name().to_string()))
        .unwrap_or_else(|| "Unknown device".into())
}

pub(crate) fn device_id_string(device: &cpal::Device) -> Option<String> {
    guarded(|| device.id().ok().map(|id| id.to_string()))
}

/// The id of the current system default output device.
pub(crate) fn current_default_id() -> Option<String> {
    let host = cpal::default_host();
    guarded(|| host.default_output_device()).and_then(|d| device_id_string(&d))
}

/// Resolves the configured device. Returns the device and whether it follows the system default.
pub(crate) fn resolve_device(config: &OutputConfig) -> Result<(cpal::Device, bool), OutputError> {
    let host = cpal::default_host();
    match &config.device_id {
        None => guarded(|| host.default_output_device())
            .map(|d| (d, true))
            .ok_or(OutputError::NoDevice),
        Some(id) => {
            let parsed = cpal::DeviceId::from_str(id)
                .map_err(|_| OutputError::DeviceNotFound(id.clone()))?;
            guarded(|| host.device_by_id(&parsed))
                .filter(|d| d.supports_output())
                .map(|d| (d, false))
                .ok_or_else(|| OutputError::DeviceNotFound(id.clone()))
        }
    }
}

/// Backend-specific part of a device id (e.g. the WASAPI endpoint id), if it belongs to `host`.
#[cfg(windows)]
pub(crate) fn wasapi_endpoint_id(id: &str) -> Option<String> {
    let parsed = cpal::DeviceId::from_str(id).ok()?;
    (parsed.host() == cpal::HostId::Wasapi).then(|| parsed.id().to_string())
}

pub(crate) fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default_id = guarded(|| host.default_output_device()).and_then(|d| device_id_string(&d));
    let Some(devices) = guarded(|| host.output_devices().ok().map(|it| it.collect::<Vec<_>>()))
    else {
        return Vec::new();
    };

    let mut out: Vec<DeviceInfo> = devices
        .iter()
        .filter_map(|device| {
            let id = device_id_string(device)?;
            let default_config = guarded(|| device.default_output_config().ok());
            let max_channels = guarded(|| {
                device
                    .supported_output_configs()
                    .ok()
                    .map(|configs| configs.map(|c| c.channels()).max().unwrap_or(0))
            })
            .unwrap_or(0)
            .max(default_config.as_ref().map_or(0, |c| c.channels()));
            Some(DeviceInfo {
                is_default: default_id.as_deref() == Some(id.as_str()),
                name: device_name(device),
                default_sample_rate: default_config.as_ref().map_or(0, |c| c.sample_rate()),
                max_channels,
                supports_exclusive: false,
                id,
            })
        })
        .collect();

    #[cfg(windows)]
    {
        let endpoints: Vec<String> = out
            .iter()
            .map(|d| wasapi_endpoint_id(&d.id).unwrap_or_default())
            .collect();
        let supported = super::wasapi_exclusive::probe_exclusive_support(endpoints);
        for (info, ok) in out.iter_mut().zip(supported) {
            info.supports_exclusive = ok;
        }
    }

    // Default first, the rest in system order.
    out.sort_by_key(|d| !d.is_default);
    out
}

pub(crate) fn device_sample_rate(config: &OutputConfig) -> Result<u32, OutputError> {
    let (device, _) = resolve_device(config)?;
    guarded(|| Some(device.default_output_config()))
        .ok_or_else(|| OutputError::Backend("device query panicked".into()))?
        .map(|c| c.sample_rate())
        .map_err(|e| OutputError::Backend(e.to_string()))
}

/// Remembers the last seen default device of a stream that follows the default, so that the
/// watcher thread and backend notifications report each change exactly once.
#[derive(Debug)]
pub(crate) struct DefaultTracker {
    last: Mutex<Option<String>>,
    events: Sender<OutputEvent>,
}

impl DefaultTracker {
    pub fn new(initial: Option<String>, events: Sender<OutputEvent>) -> Arc<Self> {
        Arc::new(Self {
            last: Mutex::new(initial),
            events,
        })
    }

    /// Compares the current default with the last one seen; reports and returns `true` on change.
    /// A vanished default (no output device left) is reported as `DeviceLost`.
    pub fn check(&self) -> bool {
        let current = current_default_id();
        let mut last = self.last.lock();
        if *last == current {
            return false;
        }
        let event = if current.is_none() {
            OutputEvent::DeviceLost
        } else {
            OutputEvent::DefaultDeviceChanged
        };
        *last = current;
        drop(last);
        let _ = self.events.try_send(event);
        true
    }
}

/// Background thread polling the default output device; stopped and joined on drop.
pub(crate) struct DefaultWatcher {
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl DefaultWatcher {
    pub fn spawn(tracker: Arc<DefaultTracker>) -> Self {
        let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(1);
        let thread = std::thread::Builder::new()
            .name("navify-default-device-watch".into())
            .spawn(move || {
                while let Err(RecvTimeoutError::Timeout) = stop_rx.recv_timeout(WATCH_INTERVAL) {
                    tracker.check();
                }
            })
            .ok();
        Self {
            stop: Some(stop_tx),
            thread,
        }
    }
}

impl Drop for DefaultWatcher {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

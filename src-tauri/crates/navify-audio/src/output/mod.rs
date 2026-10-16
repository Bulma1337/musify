//! Audio output: cpal (shared mode, all platforms) and WASAPI exclusive mode (Windows, bit-perfect).
//!
//! Contract:
//! - The output pulls interleaved stereo f32 from an `rtrb` ring filled by the engine's DSP thread.
//!   The real-time callback only copies (no allocation, no locks); on underrun it plays silence and
//!   counts an xrun.
//! - `pause`/`play` apply a ~5 ms ramp in the callback so stopping is click-free and instant.
//! - Devices with more than two channels receive stereo on the first two channels, silence elsewhere.
//! - Exclusive mode opens the device at the requested native rate with the best integer/float format
//!   it supports; f32 samples of ≤ 24-bit sources convert to the device format bit-exactly.
//!   If exclusive fails (unsupported format, device busy), fall back to shared mode and report it.
//! - Device loss / default-device changes are reported via `OutputEvent`; the engine reopens.

use crossbeam_channel::Sender;

use crate::api::{DeviceInfo, OutputConfig, OutputFormat};

#[derive(Debug, thiserror::Error)]
pub enum OutputError {
    #[error("no output device available")]
    NoDevice,
    #[error("device not found: {0}")]
    DeviceNotFound(String),
    #[error("exclusive mode unavailable: {0}")]
    ExclusiveUnavailable(String),
    #[error("output error: {0}")]
    Backend(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum OutputEvent {
    /// The opened device disappeared (unplugged, disabled).
    DeviceLost,
    /// The system default device changed (relevant when following the default).
    DefaultDeviceChanged,
    /// The stream became invalid (format change in the sound control panel, …); reopen.
    StreamInvalidated,
    Error(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputRequest {
    /// For exclusive mode: open at this rate (the track's native rate). Ignored in shared mode.
    pub exclusive_rate: Option<u32>,
    /// Target device buffer / latency.
    pub buffer_ms: u32,
}

/// A running output stream. Dropping it closes the device.
pub trait OutputStream: Send {
    fn format(&self) -> &OutputFormat;
    fn play(&mut self);
    /// Ramps down and outputs silence; the ring is not consumed while paused.
    fn pause(&mut self);
    /// Total underruns since the stream was opened.
    fn xruns(&self) -> u64;
}

/// Lists output devices (default first).
pub fn list_devices() -> Vec<DeviceInfo> {
    todo!("output: list_devices")
}

/// Shared-mode sample rate the device would run at (to size resamplers before opening).
pub fn device_sample_rate(config: &OutputConfig) -> Result<u32, OutputError> {
    let _ = config;
    todo!("output: device_sample_rate")
}

/// Opens the configured device. `ring` delivers interleaved stereo f32 at the stream's sample rate.
pub fn open(
    config: &OutputConfig,
    request: OutputRequest,
    ring: rtrb::Consumer<f32>,
    events: Sender<OutputEvent>,
) -> Result<Box<dyn OutputStream>, OutputError> {
    let _ = (config, request, ring, events);
    todo!("output: open")
}

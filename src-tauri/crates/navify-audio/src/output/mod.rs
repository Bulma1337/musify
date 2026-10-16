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
//!
//! Implementation notes:
//! - A stream starts playing at unity gain immediately (no fade-in at stream start, so the first
//!   samples are bit-exact); only `pause`/`play` ramp. An empty ring before the first data is not an
//!   xrun; xruns are counted once per underrun episode.
//! - When following the default device, changes are detected by a watcher thread (polls the default
//!   device id every second, all platforms) and, on Windows shared mode, immediately via cpal's
//!   rerouting notification. Each change is reported once as `DefaultDeviceChanged` (`DeviceLost`
//!   if no output device is left).
//! - Shared mode uses the backend's default buffer size; `buffer_ms` sizes the exclusive-mode
//!   device period.

use crossbeam_channel::Sender;

use crate::api::{DeviceInfo, OutputConfig, OutputFormat};

pub mod convert;
mod cpal_out;
mod devices;
#[cfg(windows)]
pub(crate) mod mmcss;
pub mod null;
pub mod ramp;
pub mod render;
#[cfg(windows)]
mod wasapi_exclusive;

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
    /// Drops all audio queued in the ring (used when seeking while paused). Lock-free.
    fn flush(&mut self);
}

/// Lists output devices (default first). Never panics; empty if there is no device.
pub fn list_devices() -> Vec<DeviceInfo> {
    devices::list_devices()
}

/// Shared-mode sample rate the device would run at (to size resamplers before opening).
pub fn device_sample_rate(config: &OutputConfig) -> Result<u32, OutputError> {
    devices::device_sample_rate(config)
}

/// Opens the configured device. `ring` delivers interleaved stereo f32 at the stream's sample rate.
///
/// Exclusive mode is attempted when `config.exclusive` and `request.exclusive_rate` are set. If it
/// fails for any reason the device is opened in shared mode instead (`format().exclusive == false`)
/// and an `OutputEvent::Error` with the reason is sent.
pub fn open(
    config: &OutputConfig,
    request: OutputRequest,
    ring: rtrb::Consumer<f32>,
    events: Sender<OutputEvent>,
) -> Result<Box<dyn OutputStream>, OutputError> {
    let (device, following_default) = devices::resolve_device(config)?;
    #[allow(unused_mut)]
    let mut ring = ring;

    if config.exclusive
        && let Some(rate) = request.exclusive_rate
    {
        #[cfg(windows)]
        {
            let endpoint =
                devices::device_id_string(&device).and_then(|id| devices::wasapi_endpoint_id(&id));
            let failure = match endpoint {
                Some(endpoint) => match wasapi_exclusive::ExclusiveOutput::open(
                    endpoint,
                    devices::device_name(&device),
                    rate,
                    following_default,
                    request,
                    ring,
                    events.clone(),
                ) {
                    Ok(stream) => return Ok(Box::new(stream)),
                    Err(failure) => failure,
                },
                None => (
                    "the device is not a WASAPI endpoint".to_string(),
                    Some(ring),
                ),
            };
            let (reason, recovered) = failure;
            log::warn!("audio output: exclusive mode unavailable, using shared mode: {reason}");
            let _ = events.try_send(OutputEvent::Error(
                OutputError::ExclusiveUnavailable(reason.clone()).to_string(),
            ));
            ring = recovered.ok_or(OutputError::ExclusiveUnavailable(reason))?;
        }
        #[cfg(not(windows))]
        {
            let _ = rate;
            let reason = OutputError::ExclusiveUnavailable("only supported on Windows".into());
            let _ = events.try_send(OutputEvent::Error(reason.to_string()));
        }
    }

    let stream = cpal_out::CpalOutput::open(&device, following_default, request, ring, events)?;
    Ok(Box::new(stream))
}

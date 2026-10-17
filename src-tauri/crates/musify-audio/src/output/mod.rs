//! Audio output: cpal (shared mode, all platforms) and WASAPI exclusive mode (Windows, bit-perfect).
//!
//! Contract:
//! - The output pulls interleaved stereo **f64** from an `rtrb` ring filled by the engine's DSP
//!   thread. f64 carries every integer source up to 32 bits exactly (f32 would round 32-bit
//!   samples to 24 significant bits); the conversion to the device format happens in the callback
//!   (`convert`, a few arithmetic operations per sample). The real-time callback only copies and
//!   converts (no allocation, no locks); on underrun it plays silence and counts an xrun.
//! - `pause`/`play` apply a ~5 ms ramp in the callback so stopping is click-free and instant.
//! - Devices with more than two channels receive stereo on the first two channels, silence elsewhere.
//! - Exclusive mode opens the device for a [`SourceSpec`]: at its native rate if the device accepts
//!   it, otherwise at the best supported rate ([`negotiate`]); the sample format is the highest
//!   integer resolution available (float for float sources). 24- and 32-bit integer sources and
//!   32-bit float sources convert to a suitable device format bit-exactly. If exclusive mode can't
//!   be opened at all (device busy, not allowed, no format), fall back to shared mode and report
//!   it (`OutputEvent::Error` and `OutputFormat::exclusive_fallback`).
//! - Shared mode always runs at the system mixer's rate and format (Windows: the format chosen in
//!   the sound settings); the engine resamples to it.
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

use crate::api::{DeviceInfo, DeviceSampleFormat, OutputConfig, OutputFormat};

pub mod convert;
mod cpal_out;
mod devices;
#[cfg(windows)]
pub(crate) mod mmcss;
pub mod negotiate;
pub mod null;
pub mod ramp;
pub mod render;
#[cfg(windows)]
mod wasapi_exclusive;

pub use negotiate::SourceSpec;

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputRequest {
    /// Exclusive mode: the track to open the device for (its native rate is preferred, see
    /// [`negotiate`]). Ignored in shared mode.
    pub exclusive_source: Option<SourceSpec>,
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
    /// Frames that are still to be heard once the ring has been read empty (device buffers).
    /// The engine waits this long before closing a stream at a track boundary.
    fn latency_frames(&self) -> u32 {
        0
    }
}

/// Lists output devices (default first), including their exclusive-mode capabilities (probed
/// with format queries only, cached). Never panics; empty if there is no device. Can take a
/// moment on first call: keep it off the UI thread.
pub fn list_devices() -> Vec<DeviceInfo> {
    devices::list_devices()
}

/// Shared-mode sample rate the device would run at (to size resamplers before opening).
pub fn device_sample_rate(config: &OutputConfig) -> Result<u32, OutputError> {
    devices::device_sample_rate(config)
}

/// Rate and sample format an exclusive stream for `source` would use on the configured device,
/// from its (cached) capabilities. `None` if unknown (not Windows, not probed, no exclusive mode).
pub fn exclusive_format_for(
    config: &OutputConfig,
    source: &SourceSpec,
) -> Option<(u32, DeviceSampleFormat)> {
    #[cfg(windows)]
    {
        let (device, _) = devices::resolve_device(config).ok()?;
        let endpoint =
            devices::device_id_string(&device).and_then(|id| devices::wasapi_endpoint_id(&id))?;
        let caps = match wasapi_exclusive::cached_caps(&endpoint) {
            Some(caps) => caps,
            None => wasapi_exclusive::probe_exclusive_caps(vec![endpoint])
                .pop()
                .flatten()?,
        };
        negotiate::choose(&caps, source)
    }
    #[cfg(not(windows))]
    {
        let _ = (config, source);
        None
    }
}

/// Opens the configured device. `ring` delivers interleaved stereo f64 at the stream's sample rate.
///
/// Exclusive mode is attempted when `config.exclusive` and `request.exclusive_source` are set. If
/// it fails for any reason the device is opened in shared mode instead (`format().exclusive ==
/// false`, `exclusive_fallback` set) and an `OutputEvent::Error` with the reason is sent.
pub fn open(
    config: &OutputConfig,
    request: OutputRequest,
    ring: rtrb::Consumer<f64>,
    events: Sender<OutputEvent>,
) -> Result<Box<dyn OutputStream>, OutputError> {
    let (device, following_default) = devices::resolve_device(config)?;
    #[allow(unused_mut)]
    let mut ring = ring;
    let mut fallback = None;

    if config.exclusive
        && let Some(source) = request.exclusive_source
    {
        #[cfg(windows)]
        {
            let endpoint =
                devices::device_id_string(&device).and_then(|id| devices::wasapi_endpoint_id(&id));
            let failure = match endpoint {
                Some(endpoint) => match wasapi_exclusive::ExclusiveOutput::open(
                    endpoint,
                    devices::device_name(&device),
                    source,
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
            ring = recovered.ok_or(OutputError::ExclusiveUnavailable(reason.clone()))?;
            fallback = Some(reason);
        }
        #[cfg(not(windows))]
        {
            let _ = source;
            let reason = "only supported on Windows".to_string();
            let _ = events.try_send(OutputEvent::Error(
                OutputError::ExclusiveUnavailable(reason.clone()).to_string(),
            ));
            fallback = Some(reason);
        }
    }

    let mut stream = cpal_out::CpalOutput::open(&device, following_default, request, ring, events)?;
    stream.format.exclusive_fallback = fallback;
    Ok(Box::new(stream))
}

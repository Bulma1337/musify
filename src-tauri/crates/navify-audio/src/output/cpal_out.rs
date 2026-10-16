//! Shared-mode output through cpal (all platforms).
//!
//! The stream runs at the device's default (mix) rate and channel count. f32 is used whenever the
//! device offers it; otherwise samples are converted in the callback (see `convert`).
//!
//! Default-device handling: when following the default, the cpal default device is opened. On
//! WASAPI that is the virtual default endpoint, so Windows reroutes the running stream by itself and
//! cpal reports the change as an error (`StreamInvalidated`, or `DeviceNotAvailable` if no device is
//! left). Those errors, and the polling [`DefaultWatcher`] used on every platform, go through a
//! shared [`DefaultTracker`] so each change is reported exactly once as `DefaultDeviceChanged`.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, ErrorKind, SampleFormat, StreamConfig};
use crossbeam_channel::Sender;
use rtrb::Consumer;

use super::convert::{Encoder, SampleEncoding};
use super::devices::{DefaultTracker, DefaultWatcher, current_default_id, device_name};
use super::ramp::Control;
use super::render::Renderer;
use super::{OutputError, OutputEvent, OutputRequest, OutputStream};
use crate::api::OutputFormat;

/// Frames converted per step when the device format is not f32 (bounds the scratch buffer).
const CHUNK_FRAMES: usize = 1024;

/// cpal sample format → our encoder, `None` for formats we cannot produce (DSD).
pub(crate) fn encoding_for(format: SampleFormat) -> Option<SampleEncoding> {
    Some(match format {
        SampleFormat::F32 => SampleEncoding::F32,
        SampleFormat::F64 => SampleEncoding::F64,
        SampleFormat::I8 => SampleEncoding::I8,
        SampleFormat::U8 => SampleEncoding::U8,
        SampleFormat::I16 => SampleEncoding::I16,
        SampleFormat::U16 => SampleEncoding::U16,
        SampleFormat::I24 => SampleEncoding::I24In32Low,
        SampleFormat::U24 => SampleEncoding::U24In32Low,
        SampleFormat::I32 => SampleEncoding::I32,
        SampleFormat::U32 => SampleEncoding::U32,
        SampleFormat::I64 => SampleEncoding::I64,
        SampleFormat::U64 => SampleEncoding::U64,
        _ => return None,
    })
}

/// Picks rate/channels from the device default and the best sample format at that configuration.
fn choose_config(
    device: &cpal::Device,
) -> Result<(StreamConfig, SampleFormat, SampleEncoding), OutputError> {
    let default = device.default_output_config().map_err(map_open_error)?;
    let rate = default.sample_rate();
    let channels = default.channels();
    let config = StreamConfig {
        channels,
        sample_rate: rate,
        buffer_size: BufferSize::Default,
    };

    let supported: Vec<SampleFormat> = device
        .supported_output_configs()
        .map(|it| {
            it.filter(|c| c.channels() == channels && c.contains_rate(rate))
                .map(|c| c.sample_format())
                .collect()
        })
        .unwrap_or_default();

    let preference = [
        SampleFormat::F32,
        SampleFormat::I32,
        SampleFormat::I24,
        SampleFormat::F64,
        SampleFormat::I16,
        SampleFormat::U16,
        SampleFormat::U8,
    ];
    let format =
        if default.sample_format() == SampleFormat::F32 || supported.contains(&SampleFormat::F32) {
            SampleFormat::F32
        } else if encoding_for(default.sample_format()).is_some() {
            default.sample_format()
        } else {
            preference
                .into_iter()
                .find(|f| supported.contains(f))
                .ok_or_else(|| {
                    OutputError::Backend(format!(
                        "unsupported device sample format {:?}",
                        default.sample_format()
                    ))
                })?
        };
    let encoding = encoding_for(format).expect("format chosen from encodable set");
    Ok((config, format, encoding))
}

fn map_open_error(e: cpal::Error) -> OutputError {
    OutputError::Backend(e.to_string())
}

/// What a cpal stream error means for the engine.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ErrorAction {
    Event(OutputEvent),
    Xrun,
    Ignore,
}

pub(crate) fn classify_error(kind: ErrorKind, message: String) -> ErrorAction {
    match kind {
        ErrorKind::DeviceNotAvailable => ErrorAction::Event(OutputEvent::DeviceLost),
        ErrorKind::DeviceChanged => ErrorAction::Event(OutputEvent::DefaultDeviceChanged),
        ErrorKind::StreamInvalidated => ErrorAction::Event(OutputEvent::StreamInvalidated),
        ErrorKind::Xrun => ErrorAction::Xrun,
        ErrorKind::RealtimeDenied => ErrorAction::Ignore,
        _ => ErrorAction::Event(OutputEvent::Error(message)),
    }
}

pub(crate) struct CpalOutput {
    // Field order = drop order: stop the device before the watcher.
    _stream: cpal::Stream,
    _watcher: Option<DefaultWatcher>,
    control: Arc<Control>,
    format: OutputFormat,
}

impl CpalOutput {
    pub fn open(
        device: &cpal::Device,
        following_default: bool,
        _request: OutputRequest,
        mut ring: Consumer<f32>,
        events: Sender<OutputEvent>,
    ) -> Result<Self, OutputError> {
        let (config, sample_format, encoding) = choose_config(device)?;
        let channels = config.channels;
        let control = Control::new();
        let mut renderer = Renderer::new(channels, config.sample_rate, control.clone());
        let mut encoder = Encoder::new(encoding);
        let mut scratch = vec![0.0f32; CHUNK_FRAMES * channels as usize];
        let chunk_bytes = CHUNK_FRAMES * channels as usize * encoding.bytes_per_sample();
        let bytes_per_sample = encoding.bytes_per_sample();

        #[cfg(windows)]
        let mut mmcss_done = false;
        let data_callback = move |data: &mut cpal::Data, _: &cpal::OutputCallbackInfo| {
            #[cfg(windows)]
            if !mmcss_done {
                mmcss_done = true;
                super::mmcss::register_current_thread();
            }
            if encoding == SampleEncoding::F32
                && let Some(out) = data.as_slice_mut::<f32>()
            {
                renderer.render(&mut ring, out);
                return;
            }
            for chunk in data.bytes_mut().chunks_mut(chunk_bytes) {
                let n = chunk.len() / bytes_per_sample;
                let src = &mut scratch[..n];
                renderer.render(&mut ring, src);
                encoder.encode(src, chunk);
            }
        };

        let tracker =
            following_default.then(|| DefaultTracker::new(current_default_id(), events.clone()));
        let error_tracker = tracker.clone();
        let error_control = control.clone();
        let error_events = events.clone();
        let error_callback = move |err: cpal::Error| {
            let kind = err.kind();
            if let Some(tracker) = &error_tracker
                && matches!(
                    kind,
                    ErrorKind::DeviceNotAvailable
                        | ErrorKind::StreamInvalidated
                        | ErrorKind::DeviceChanged
                )
                && (tracker.check() || kind == ErrorKind::DeviceChanged)
            {
                // Reported as a default-device change (now, or already by the watcher).
                return;
            }
            match classify_error(kind, err.to_string()) {
                ErrorAction::Event(event) => {
                    log::warn!("audio output: {err}");
                    let _ = error_events.try_send(event);
                }
                ErrorAction::Xrun => error_control.add_xrun(),
                ErrorAction::Ignore => log::debug!("audio output: {err}"),
            }
        };

        let stream = device
            .build_output_stream_raw(config, sample_format, data_callback, error_callback, None)
            .map_err(map_open_error)?;
        stream.play().map_err(map_open_error)?;

        let watcher = tracker.map(DefaultWatcher::spawn);
        let format = OutputFormat {
            device_name: device_name(device),
            sample_rate: config.sample_rate,
            channels,
            exclusive: false,
            bit_perfect: false,
        };
        log::info!(
            "audio output: shared mode, {} Hz, {} ch, {:?} on {}",
            format.sample_rate,
            format.channels,
            sample_format,
            format.device_name
        );
        Ok(Self {
            _stream: stream,
            _watcher: watcher,
            control,
            format,
        })
    }
}

impl OutputStream for CpalOutput {
    fn format(&self) -> &OutputFormat {
        &self.format
    }

    fn play(&mut self) {
        self.control.set_paused(false);
    }

    fn pause(&mut self) {
        self.control.set_paused(true);
    }

    fn xruns(&self) -> u64 {
        self.control.xruns()
    }

    fn flush(&mut self) {
        self.control.request_flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_map_to_events() {
        let ev = |k| classify_error(k, "msg".into());
        assert_eq!(
            ev(ErrorKind::DeviceNotAvailable),
            ErrorAction::Event(OutputEvent::DeviceLost)
        );
        assert_eq!(
            ev(ErrorKind::DeviceChanged),
            ErrorAction::Event(OutputEvent::DefaultDeviceChanged)
        );
        assert_eq!(
            ev(ErrorKind::StreamInvalidated),
            ErrorAction::Event(OutputEvent::StreamInvalidated)
        );
        assert_eq!(ev(ErrorKind::Xrun), ErrorAction::Xrun);
        assert_eq!(ev(ErrorKind::RealtimeDenied), ErrorAction::Ignore);
        assert_eq!(
            ev(ErrorKind::DeviceBusy),
            ErrorAction::Event(OutputEvent::Error("msg".into()))
        );
    }

    #[test]
    fn sample_formats_map_to_encodings() {
        assert_eq!(encoding_for(SampleFormat::F32), Some(SampleEncoding::F32));
        assert_eq!(
            encoding_for(SampleFormat::I24),
            Some(SampleEncoding::I24In32Low)
        );
        assert_eq!(encoding_for(SampleFormat::U16), Some(SampleEncoding::U16));
        assert_eq!(encoding_for(SampleFormat::DsdU8), None);
    }
}

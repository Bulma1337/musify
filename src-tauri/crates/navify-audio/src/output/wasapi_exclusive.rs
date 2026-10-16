//! WASAPI exclusive-mode output (Windows): bit-perfect, event-driven render thread.
//!
//! Format negotiation (at exactly the requested rate, device channel count first, then stereo):
//! 32-bit int container with 24 valid bits → 32-bit int → packed 24-bit → 32-bit float → 16-bit.
//! Each candidate is checked with `IsFormatSupported(EXCLUSIVE)` including the usual driver quirks
//! (WAVEFORMATEX vs. WAVEFORMATEXTENSIBLE, channel masks).
//!
//! All COM objects live on the render thread (MTA, MMCSS "Pro Audio"). The thread reports the
//! outcome of initialization back to `open`; on failure it hands the ring back so the caller can
//! fall back to shared mode.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use crossbeam_channel::Sender;
use rtrb::Consumer;
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WasapiError, WaveFormat};
use windows::Win32::Foundation::E_INVALIDARG;
use windows::Win32::Media::Audio::{
    AUDCLNT_E_BUFFER_SIZE_ERROR, AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE,
    AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_ENDPOINT_CREATE_FAILED, AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED,
    AUDCLNT_E_INVALID_DEVICE_PERIOD, AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_UNSUPPORTED_FORMAT,
};
use windows::core::HRESULT;

use super::convert::{Encoder, SampleEncoding};
use super::devices::{DefaultTracker, DefaultWatcher, current_default_id};
use super::mmcss::MmcssGuard;
use super::ramp::Control;
use super::render::Renderer;
use super::{OutputEvent, OutputRequest, OutputStream};
use crate::api::OutputFormat;

/// Not exported by the `windows` crate.
const AUDCLNT_E_BUFFER_DURATION_PERIOD_NOT_EQUAL: HRESULT = HRESULT(0x8889_0013_u32 as i32);

/// Longest device period we ask for (100 ns units): 100 ms.
const MAX_PERIOD_HNS: i64 = 1_000_000;
/// Event wait slice; also bounds how long closing the stream can take.
const WAIT_MS: u32 = 200;
/// No buffer request for this long → the device is considered gone.
const STALL_LIMIT_MS: u32 = 2000;

#[derive(Clone, Copy, Debug)]
struct Candidate {
    store_bits: usize,
    valid_bits: usize,
    sample_type: SampleType,
    encoding: SampleEncoding,
}

const CANDIDATES: [Candidate; 5] = [
    Candidate { store_bits: 32, valid_bits: 24, sample_type: SampleType::Int, encoding: SampleEncoding::I24In32High },
    Candidate { store_bits: 32, valid_bits: 32, sample_type: SampleType::Int, encoding: SampleEncoding::I32 },
    Candidate { store_bits: 24, valid_bits: 24, sample_type: SampleType::Int, encoding: SampleEncoding::I24Packed },
    Candidate { store_bits: 32, valid_bits: 32, sample_type: SampleType::Float, encoding: SampleEncoding::F32 },
    Candidate { store_bits: 16, valid_bits: 16, sample_type: SampleType::Int, encoding: SampleEncoding::I16 },
];

/// COM apartment for a thread we own; uninitialized on drop if we initialized it.
struct ComGuard(bool);

impl ComGuard {
    fn mta() -> Self {
        ComGuard(wasapi::initialize_mta().is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            wasapi::deinitialize();
        }
    }
}

fn hresult(e: &WasapiError) -> Option<HRESULT> {
    match e {
        WasapiError::Windows(w) => Some(w.code()),
        _ => None,
    }
}

fn describe(e: &WasapiError) -> String {
    match hresult(e) {
        Some(AUDCLNT_E_DEVICE_IN_USE) => "the device is in use by another application".into(),
        Some(AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED) => "exclusive mode is not allowed for this device".into(),
        Some(AUDCLNT_E_UNSUPPORTED_FORMAT) => "the device does not support the format".into(),
        Some(AUDCLNT_E_ENDPOINT_CREATE_FAILED) | Some(AUDCLNT_E_DEVICE_INVALIDATED) => {
            "the device is not available".into()
        }
        _ => e.to_string(),
    }
}

fn event_for(e: &WasapiError) -> OutputEvent {
    match hresult(e) {
        Some(AUDCLNT_E_DEVICE_INVALIDATED) | Some(AUDCLNT_E_ENDPOINT_CREATE_FAILED) => OutputEvent::DeviceLost,
        Some(AUDCLNT_E_RESOURCES_INVALIDATED) => OutputEvent::StreamInvalidated,
        _ => OutputEvent::Error(format!("exclusive output: {}", describe(e))),
    }
}

/// Channel counts to try: the device's own count first, then stereo.
fn channel_options(mix_channels: usize) -> Vec<usize> {
    let mut options = vec![mix_channels.max(1)];
    if !options.contains(&2) {
        options.push(2);
    }
    options
}

/// The best exclusive format at `rate`, without opening the device.
fn negotiate(client: &AudioClient, rate: u32, channels: &[usize]) -> Option<(WaveFormat, Candidate, usize)> {
    for &ch in channels {
        for cand in CANDIDATES {
            let wanted = WaveFormat::new(cand.store_bits, cand.valid_bits, &cand.sample_type, rate as usize, ch, None);
            if let Ok(accepted) = client.is_supported_exclusive_with_quirks(&wanted) {
                return Some((accepted, cand, ch));
            }
        }
    }
    None
}

/// Exclusive-mode support per WASAPI endpoint id (empty id → `false`). Queries the driver with
/// `IsFormatSupported` only; nothing is opened. Runs on a short-lived MTA thread.
pub(crate) fn probe_exclusive_support(endpoints: Vec<String>) -> Vec<bool> {
    let count = endpoints.len();
    std::thread::Builder::new()
        .name("navify-exclusive-probe".into())
        .spawn(move || {
            let _com = ComGuard::mta();
            let Ok(enumerator) = wasapi::DeviceEnumerator::new() else {
                return vec![false; endpoints.len()];
            };
            endpoints
                .iter()
                .map(|id| {
                    if id.is_empty() {
                        return false;
                    }
                    let probe = || -> Option<bool> {
                        let device = enumerator.get_device(id).ok()?;
                        let client = device.get_iaudioclient().ok()?;
                        let mix = client.get_mixformat().ok()?;
                        let mut rates = vec![mix.get_samplespersec(), 48_000, 44_100];
                        rates.dedup();
                        let channels = channel_options(mix.get_nchannels() as usize);
                        Some(rates.iter().any(|&rate| negotiate(&client, rate, &channels).is_some()))
                    };
                    probe().unwrap_or(false)
                })
                .collect()
        })
        .ok()
        .and_then(|t| t.join().ok())
        .unwrap_or_else(|| vec![false; count])
}

struct Params {
    endpoint_id: String,
    rate: u32,
    buffer_ms: u32,
}

struct Opened {
    channels: u16,
    candidate: Candidate,
}

type InitResult = Result<Opened, (String, Consumer<f32>)>;

/// Creates and initializes an event-driven exclusive client, handling period alignment.
fn initialize_client(device: &wasapi::Device, format: &WaveFormat, buffer_ms: u32) -> Result<AudioClient, WasapiError> {
    let rate = i64::from(format.get_samplespersec());
    let mut client = device.get_iaudioclient()?;
    let (default_period, min_period) = client.get_device_period()?;
    // The device double-buffers one period each, so a period of half the target keeps the device
    // latency around `buffer_ms`.
    let desired = (i64::from(buffer_ms) * 10_000 / 2).clamp(min_period, MAX_PERIOD_HNS.max(min_period));
    let period = client.calculate_aligned_period_near(desired, Some(128), format)?;
    let mode = StreamMode::EventsExclusive { period_hns: period };
    match client.initialize_client(format, &Direction::Render, &mode) {
        Ok(()) => Ok(client),
        Err(e) if hresult(&e) == Some(AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) => {
            // Documented recovery: use the next aligned buffer size on a fresh client.
            let frames = client.get_buffer_size()?;
            let aligned = wasapi::calculate_period_100ns(i64::from(frames), rate);
            let mut client = device.get_iaudioclient()?;
            client.initialize_client(
                format,
                &Direction::Render,
                &StreamMode::EventsExclusive { period_hns: aligned },
            )?;
            Ok(client)
        }
        Err(e)
            if matches!(
                hresult(&e),
                Some(E_INVALIDARG)
                    | Some(AUDCLNT_E_BUFFER_SIZE_ERROR)
                    | Some(AUDCLNT_E_INVALID_DEVICE_PERIOD)
                    | Some(AUDCLNT_E_BUFFER_DURATION_PERIOD_NOT_EQUAL)
            ) =>
        {
            // Some drivers only accept their default period.
            let mut client = device.get_iaudioclient()?;
            let period = client.calculate_aligned_period_near(default_period, Some(128), format)?;
            client.initialize_client(
                format,
                &Direction::Render,
                &StreamMode::EventsExclusive { period_hns: period },
            )?;
            Ok(client)
        }
        Err(e) => Err(e),
    }
}

fn render_thread(
    params: Params,
    mut ring: Consumer<f32>,
    control: Arc<Control>,
    events: Sender<OutputEvent>,
    init: Sender<InitResult>,
    stop: Arc<AtomicBool>,
) {
    let _com = ComGuard::mta();

    // --- setup (errors hand the ring back) ---
    let setup = || -> Result<_, String> {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| describe(&e))?;
        let device = enumerator.get_device(&params.endpoint_id).map_err(|e| describe(&e))?;
        let probe_client = device.get_iaudioclient().map_err(|e| describe(&e))?;
        let mix = probe_client.get_mixformat().map_err(|e| describe(&e))?;
        let (format, candidate, channels) =
            negotiate(&probe_client, params.rate, &channel_options(mix.get_nchannels() as usize))
                .ok_or_else(|| format!("the device does not support {} Hz in exclusive mode", params.rate))?;
        drop(probe_client);
        let client = initialize_client(&device, &format, params.buffer_ms).map_err(|e| describe(&e))?;
        let event = client.set_get_eventhandle().map_err(|e| describe(&e))?;
        let render_client = client.get_audiorenderclient().map_err(|e| describe(&e))?;
        let buffer_frames = client.get_buffer_size().map_err(|e| describe(&e))? as usize;
        Ok((client, event, render_client, buffer_frames, format, candidate, channels))
    };
    let (client, event, render_client, buffer_frames, format, candidate, channels) = match setup() {
        Ok(s) => s,
        Err(msg) => {
            let _ = init.send(Err((msg, ring)));
            return;
        }
    };

    let _mmcss = MmcssGuard::pro_audio();
    let block_align = format.get_blockalign() as usize;
    let mut scratch = vec![0.0f32; buffer_frames * channels];
    let mut bytes = vec![0u8; buffer_frames * block_align];
    let mut renderer = Renderer::new(channels as u16, params.rate, control.clone());
    let mut encoder = Encoder::new(candidate.encoding);

    // Pre-roll one buffer of silence, then start.
    if let Err(e) = render_client.write_to_device(buffer_frames, &bytes, None).and_then(|_| client.start_stream()) {
        drop((render_client, event, client));
        let _ = init.send(Err((describe(&e), ring)));
        return;
    }
    let _ = init.send(Ok(Opened { channels: channels as u16, candidate }));
    drop(init);

    let mut stalled_ms = 0u32;
    while !stop.load(Ordering::Acquire) {
        if event.wait_for_event(WAIT_MS).is_err() {
            // No buffer request: check whether the device is still there.
            if let Err(e) = client.get_current_padding() {
                let _ = events.try_send(event_for(&e));
                break;
            }
            stalled_ms += WAIT_MS;
            if stalled_ms >= STALL_LIMIT_MS {
                let _ =
                    events.try_send(OutputEvent::Error("exclusive output: the device stopped requesting audio".into()));
                break;
            }
            continue;
        }
        stalled_ms = 0;
        renderer.render(&mut ring, &mut scratch);
        encoder.encode(&scratch, &mut bytes);
        if let Err(e) = render_client.write_to_device(buffer_frames, &bytes, None) {
            let _ = events.try_send(event_for(&e));
            break;
        }
    }
    let _ = client.stop_stream();
    // `render_client`, `event`, `client` (releasing the device) drop here, then MMCSS and COM.
}

pub(crate) struct ExclusiveOutput {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    _watcher: Option<DefaultWatcher>,
    control: Arc<Control>,
    format: OutputFormat,
}

/// Why exclusive mode could not be opened, plus the ring if it could be recovered.
pub(crate) type OpenFailure = (String, Option<Consumer<f32>>);

impl ExclusiveOutput {
    pub fn open(
        endpoint_id: String,
        device_name: String,
        rate: u32,
        following_default: bool,
        request: OutputRequest,
        ring: Consumer<f32>,
        events: Sender<OutputEvent>,
    ) -> Result<Self, OpenFailure> {
        let control = Control::new();
        let stop = Arc::new(AtomicBool::new(false));
        let (init_tx, init_rx) = crossbeam_channel::bounded::<InitResult>(1);
        let params = Params { endpoint_id, rate, buffer_ms: request.buffer_ms };
        let thread = {
            let control = control.clone();
            let events = events.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("navify-wasapi-exclusive".into())
                .spawn(move || render_thread(params, ring, control, events, init_tx, stop))
                .map_err(|e| (format!("cannot start render thread: {e}"), None))?
        };

        let opened = match init_rx.recv() {
            Ok(Ok(opened)) => opened,
            Ok(Err((msg, ring))) => {
                let _ = thread.join();
                return Err((msg, Some(ring)));
            }
            Err(_) => {
                let _ = thread.join();
                return Err(("exclusive render thread failed during initialization".into(), None));
            }
        };

        let watcher =
            following_default.then(|| DefaultWatcher::spawn(DefaultTracker::new(current_default_id(), events.clone())));
        let candidate = opened.candidate;
        let format = OutputFormat {
            device_name,
            sample_rate: rate,
            channels: opened.channels,
            exclusive: true,
            bit_perfect: candidate.sample_type == SampleType::Int && candidate.valid_bits >= 24,
        };
        log::info!(
            "audio output: exclusive mode, {} Hz, {} ch, {}/{} bit {:?} on {}",
            rate,
            opened.channels,
            candidate.valid_bits,
            candidate.store_bits,
            candidate.sample_type,
            format.device_name
        );
        Ok(Self { stop, thread: Some(thread), _watcher: watcher, control, format })
    }
}

impl Drop for ExclusiveOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl OutputStream for ExclusiveOutput {
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

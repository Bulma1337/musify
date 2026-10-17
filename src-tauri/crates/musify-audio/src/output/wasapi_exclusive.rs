//! WASAPI exclusive-mode output (Windows): bit-perfect, event-driven render thread.
//!
//! Rate and format negotiation follows [`super::negotiate`]: the track's native rate first, then
//! the best other rate the driver accepts (same family up, same family down, other family …).
//! At the chosen rate the sample formats are tried in the source's order of preference (integer
//! sources: 32-in-32 → 24-in-32 → packed 24 → 32-bit float → 16; float sources: float first), each
//! with `IsFormatSupported(EXCLUSIVE)` including the usual driver quirks (WAVEFORMATEX vs.
//! WAVEFORMATEXTENSIBLE, channel masks), device channel count first, then stereo. A driver that
//! accepts a format in `IsFormatSupported` but rejects it in `Initialize` moves the search on to
//! the next rate. Only if nothing can be opened does the caller fall back to shared mode.
//!
//! Device capabilities (every probe rate × format) are probed with `IsFormatSupported` only and
//! cached per endpoint and mix format, so the device list and the engine's reopen decisions never
//! open the device.
//!
//! All COM objects live on the render thread (MTA, MMCSS "Pro Audio"). The thread reports the
//! outcome of initialization back to `open`; on failure it hands the ring back so the caller can
//! fall back to shared mode.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use rtrb::Consumer;
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WasapiError, WaveFormat};
use windows::Win32::Foundation::E_INVALIDARG;
use windows::Win32::Media::Audio::{
    AUDCLNT_E_BUFFER_SIZE_ERROR, AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE,
    AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_ENDPOINT_CREATE_FAILED,
    AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_E_INVALID_DEVICE_PERIOD,
    AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_UNSUPPORTED_FORMAT,
};
use windows::core::HRESULT;

use super::convert::{Encoder, SampleEncoding};
use super::devices::{DefaultTracker, DefaultWatcher, current_default_id};
use super::mmcss::MmcssGuard;
use super::negotiate::{INT_PREFERENCE, PROBE_RATES, SourceSpec, rank_rates};
use super::ramp::Control;
use super::render::Renderer;
use super::{OutputEvent, OutputRequest, OutputStream};
use crate::api::{DeviceSampleFormat, ExclusiveCaps, ExclusiveMode, OutputFormat};

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
    format: DeviceSampleFormat,
}

const CANDIDATES: [Candidate; 5] = [
    Candidate {
        store_bits: 32,
        valid_bits: 32,
        sample_type: SampleType::Int,
        encoding: SampleEncoding::I32,
        format: DeviceSampleFormat::Int32,
    },
    Candidate {
        store_bits: 32,
        valid_bits: 24,
        sample_type: SampleType::Int,
        encoding: SampleEncoding::I24In32High,
        format: DeviceSampleFormat::Int24In32,
    },
    Candidate {
        store_bits: 24,
        valid_bits: 24,
        sample_type: SampleType::Int,
        encoding: SampleEncoding::I24Packed,
        format: DeviceSampleFormat::Int24,
    },
    Candidate {
        store_bits: 32,
        valid_bits: 32,
        sample_type: SampleType::Float,
        encoding: SampleEncoding::F32,
        format: DeviceSampleFormat::Float32,
    },
    Candidate {
        store_bits: 16,
        valid_bits: 16,
        sample_type: SampleType::Int,
        encoding: SampleEncoding::I16,
        format: DeviceSampleFormat::Int16,
    },
];

fn candidate(format: DeviceSampleFormat) -> Option<Candidate> {
    CANDIDATES.iter().copied().find(|c| c.format == format)
}

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
        Some(AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED) => {
            "exclusive mode is not allowed for this device".into()
        }
        Some(AUDCLNT_E_UNSUPPORTED_FORMAT) => "the device does not support the format".into(),
        Some(AUDCLNT_E_ENDPOINT_CREATE_FAILED) | Some(AUDCLNT_E_DEVICE_INVALIDATED) => {
            "the device is not available".into()
        }
        _ => e.to_string(),
    }
}

fn event_for(e: &WasapiError) -> OutputEvent {
    match hresult(e) {
        Some(AUDCLNT_E_DEVICE_INVALIDATED) | Some(AUDCLNT_E_ENDPOINT_CREATE_FAILED) => {
            OutputEvent::DeviceLost
        }
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

/// The first format of `prefs` the driver accepts at `rate`, without opening the device.
fn negotiate(
    client: &AudioClient,
    rate: u32,
    channels: &[usize],
    prefs: &[DeviceSampleFormat],
) -> Option<(WaveFormat, Candidate, usize)> {
    for &ch in channels {
        for cand in prefs.iter().filter_map(|&f| candidate(f)) {
            let wanted = WaveFormat::new(
                cand.store_bits,
                cand.valid_bits,
                &cand.sample_type,
                rate as usize,
                ch,
                None,
            );
            if let Ok(accepted) = client.is_supported_exclusive_with_quirks(&wanted) {
                return Some((accepted, cand, ch));
            }
        }
    }
    None
}

/// Every probe rate × format the driver accepts (formats in the integer preference order).
fn probe_caps(client: &AudioClient, channels: &[usize]) -> ExclusiveCaps {
    let modes = PROBE_RATES
        .iter()
        .filter_map(|&rate| {
            let formats: Vec<DeviceSampleFormat> = INT_PREFERENCE
                .iter()
                .copied()
                .filter(|&f| negotiate(client, rate, channels, &[f]).is_some())
                .collect();
            (!formats.is_empty()).then_some(ExclusiveMode {
                sample_rate: rate,
                formats,
            })
        })
        .collect();
    ExclusiveCaps { modes }
}

struct CacheEntry {
    endpoint: String,
    mix_rate: u32,
    mix_channels: u16,
    caps: ExclusiveCaps,
}

/// Probed capabilities. Never touched by audio threads.
static CAPS_CACHE: Mutex<Vec<CacheEntry>> = parking_lot::const_mutex(Vec::new());

/// Cached capabilities of `endpoint` (any mix format), without querying the driver.
pub(crate) fn cached_caps(endpoint: &str) -> Option<ExclusiveCaps> {
    CAPS_CACHE
        .lock()
        .iter()
        .find(|e| e.endpoint == endpoint)
        .map(|e| e.caps.clone())
}

/// Exclusive-mode capabilities per WASAPI endpoint id (empty id → `None`). Queries the driver
/// with `IsFormatSupported` only; nothing is opened. Results are cached per endpoint and mix
/// format (a format change in the sound settings probes again). Runs on a short-lived MTA thread.
pub(crate) fn probe_exclusive_caps(endpoints: Vec<String>) -> Vec<Option<ExclusiveCaps>> {
    let count = endpoints.len();
    std::thread::Builder::new()
        .name("musify-exclusive-probe".into())
        .spawn(move || {
            let _com = ComGuard::mta();
            let Ok(enumerator) = wasapi::DeviceEnumerator::new() else {
                return vec![None; endpoints.len()];
            };
            endpoints
                .iter()
                .map(|id| {
                    if id.is_empty() {
                        return None;
                    }
                    let device = enumerator.get_device(id).ok()?;
                    let client = device.get_iaudioclient().ok()?;
                    let mix = client.get_mixformat().ok()?;
                    let (mix_rate, mix_channels) = (mix.get_samplespersec(), mix.get_nchannels());
                    if let Some(entry) = CAPS_CACHE.lock().iter().find(|e| {
                        e.endpoint == *id
                            && e.mix_rate == mix_rate
                            && e.mix_channels == mix_channels
                    }) {
                        return Some(entry.caps.clone());
                    }
                    let caps = probe_caps(&client, &channel_options(mix_channels as usize));
                    // An empty result may be transient (device busy); probe again next time.
                    if !caps.is_empty() {
                        let mut cache = CAPS_CACHE.lock();
                        cache.retain(|e| e.endpoint != *id);
                        cache.push(CacheEntry {
                            endpoint: id.clone(),
                            mix_rate,
                            mix_channels,
                            caps: caps.clone(),
                        });
                    }
                    Some(caps)
                })
                .collect()
        })
        .ok()
        .and_then(|t| t.join().ok())
        .unwrap_or_else(|| vec![None; count])
}

struct Params {
    endpoint_id: String,
    source: SourceSpec,
    buffer_ms: u32,
}

struct Opened {
    rate: u32,
    channels: u16,
    candidate: Candidate,
    buffer_frames: usize,
}

type InitResult = Result<Opened, (String, Consumer<f64>)>;

/// Creates and initializes an event-driven exclusive client, handling period alignment.
fn initialize_client(
    device: &wasapi::Device,
    format: &WaveFormat,
    buffer_ms: u32,
) -> Result<AudioClient, WasapiError> {
    let rate = i64::from(format.get_samplespersec());
    let mut client = device.get_iaudioclient()?;
    let (default_period, min_period) = client.get_device_period()?;
    // The device double-buffers one period each, so a period of half the target keeps the device
    // latency around `buffer_ms`.
    let desired =
        (i64::from(buffer_ms) * 10_000 / 2).clamp(min_period, MAX_PERIOD_HNS.max(min_period));
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
                &StreamMode::EventsExclusive {
                    period_hns: aligned,
                },
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

/// Opens the best (rate, format) for `source`: see the module docs.
fn open_best(
    device: &wasapi::Device,
    source: &SourceSpec,
    buffer_ms: u32,
) -> Result<(AudioClient, WaveFormat, Candidate, usize, u32), String> {
    let probe_client = device.get_iaudioclient().map_err(|e| describe(&e))?;
    let mix = probe_client.get_mixformat().map_err(|e| describe(&e))?;
    let channels = channel_options(mix.get_nchannels() as usize);
    let prefs = source.format_preference();
    let rates = rank_rates(
        source.sample_rate,
        PROBE_RATES.iter().copied().chain([source.sample_rate]),
    );
    let mut last_error = None;
    for rate in rates {
        let Some((format, cand, ch)) = negotiate(&probe_client, rate, &channels, prefs) else {
            continue;
        };
        match initialize_client(device, &format, buffer_ms) {
            Ok(client) => return Ok((client, format, cand, ch, rate)),
            // Accepted by IsFormatSupported but not by Initialize: try the next rate.
            Err(e) if hresult(&e) == Some(AUDCLNT_E_UNSUPPORTED_FORMAT) => {
                last_error = Some(describe(&e));
            }
            Err(e) => return Err(describe(&e)),
        }
    }
    Err(last_error.unwrap_or_else(|| "the device supports no exclusive-mode format".into()))
}

fn render_thread(
    params: Params,
    mut ring: Consumer<f64>,
    control: Arc<Control>,
    events: Sender<OutputEvent>,
    init: Sender<InitResult>,
    stop: Arc<AtomicBool>,
) {
    let _com = ComGuard::mta();

    // --- setup (errors hand the ring back) ---
    let setup = || -> Result<_, String> {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| describe(&e))?;
        let device = enumerator
            .get_device(&params.endpoint_id)
            .map_err(|e| describe(&e))?;
        let (client, format, candidate, channels, rate) =
            open_best(&device, &params.source, params.buffer_ms)?;
        let event = client.set_get_eventhandle().map_err(|e| describe(&e))?;
        let render_client = client.get_audiorenderclient().map_err(|e| describe(&e))?;
        let buffer_frames = client.get_buffer_size().map_err(|e| describe(&e))? as usize;
        Ok((
            client,
            event,
            render_client,
            buffer_frames,
            format,
            candidate,
            channels,
            rate,
        ))
    };
    let (client, event, render_client, buffer_frames, format, candidate, channels, rate) =
        match setup() {
            Ok(s) => s,
            Err(msg) => {
                let _ = init.send(Err((msg, ring)));
                return;
            }
        };

    let _mmcss = MmcssGuard::pro_audio();
    let block_align = format.get_blockalign() as usize;
    let mut scratch = vec![0.0f64; buffer_frames * channels];
    let mut bytes = vec![0u8; buffer_frames * block_align];
    let mut renderer = Renderer::new(channels as u16, rate, control.clone());
    let mut encoder = Encoder::new(candidate.encoding);

    // Pre-roll one buffer of silence, then start.
    if let Err(e) = render_client
        .write_to_device(buffer_frames, &bytes, None)
        .and_then(|_| client.start_stream())
    {
        drop((render_client, event, client));
        let _ = init.send(Err((describe(&e), ring)));
        return;
    }
    let _ = init.send(Ok(Opened {
        rate,
        channels: channels as u16,
        candidate,
        buffer_frames,
    }));
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
                let _ = events.try_send(OutputEvent::Error(
                    "exclusive output: the device stopped requesting audio".into(),
                ));
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
    latency_frames: u32,
}

/// Why exclusive mode could not be opened, plus the ring if it could be recovered.
pub(crate) type OpenFailure = (String, Option<Consumer<f64>>);

impl ExclusiveOutput {
    pub fn open(
        endpoint_id: String,
        device_name: String,
        source: SourceSpec,
        following_default: bool,
        request: OutputRequest,
        ring: Consumer<f64>,
        events: Sender<OutputEvent>,
    ) -> Result<Self, OpenFailure> {
        let control = Control::new();
        let stop = Arc::new(AtomicBool::new(false));
        let (init_tx, init_rx) = crossbeam_channel::bounded::<InitResult>(1);
        let params = Params {
            endpoint_id,
            source,
            buffer_ms: request.buffer_ms,
        };
        let thread = {
            let control = control.clone();
            let events = events.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("musify-wasapi-exclusive".into())
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
                return Err((
                    "exclusive render thread failed during initialization".into(),
                    None,
                ));
            }
        };

        let watcher = following_default.then(|| {
            DefaultWatcher::spawn(DefaultTracker::new(current_default_id(), events.clone()))
        });
        let candidate = opened.candidate;
        let format = OutputFormat {
            device_name,
            sample_rate: opened.rate,
            channels: opened.channels,
            exclusive: true,
            // The stream itself passes samples unchanged; the engine decides the final flag.
            bit_perfect: candidate.sample_type == SampleType::Int && candidate.valid_bits >= 24,
            sample_format: Some(candidate.format),
            source_rate: None,
            resampled: false,
            exclusive_fallback: None,
        };
        log::info!(
            "audio output: exclusive mode, {} Hz (track {} Hz), {} ch, {}/{} bit {:?}, buffer {} frames on {}",
            opened.rate,
            source.sample_rate,
            opened.channels,
            candidate.valid_bits,
            candidate.store_bits,
            candidate.sample_type,
            opened.buffer_frames,
            format.device_name
        );
        Ok(Self {
            stop,
            thread: Some(thread),
            _watcher: watcher,
            control,
            format,
            // One buffer queued in the device plus the one being written.
            latency_frames: (2 * opened.buffer_frames) as u32,
        })
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

    fn latency_frames(&self) -> u32 {
        self.latency_frames
    }
}

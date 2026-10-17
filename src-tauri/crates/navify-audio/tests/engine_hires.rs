//! Hi-res playback through the whole engine against a simulated exclusive-mode device with a
//! configurable list of supported rates and sample formats: bit-exact output at native rates up to
//! 352.8 kHz for 24-bit, 32-bit integer and 32-bit float sources, best-rate fallback, device reopen
//! when the rate changes between tracks, and exclusive mode with DSP active.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use navify_audio::api::{
    DeviceSampleFormat, DspConfig, EngineCommand, EngineEvent, EqConfig, EqMode, ExclusiveCaps,
    ExclusiveMode, GraphicBands, OutputConfig, OutputFormat, SourceLocation, TrackSource,
    Transition,
};
use navify_audio::engine::OutputFactory;
use navify_audio::output::negotiate::{self, SourceSpec};
use navify_audio::output::null::{NullOutput, NullPacing, NullSamples};
use navify_audio::output::{OutputError, OutputEvent, OutputRequest, OutputStream};
use navify_audio::source::CacheConfig;
use navify_audio::{AudioEngine, EngineInit};

const SHARED_RATE: u32 = 48_000;
const TRACK_SECONDS: f64 = 0.4;

/// A device that accepts `caps` in exclusive mode and runs at 48 kHz float in shared mode.
struct CapsFactory {
    caps: ExclusiveCaps,
    /// Every opened stream: (rate, exclusive).
    opens: Arc<Mutex<Vec<(u32, bool)>>>,
    samples: Arc<Mutex<Option<NullSamples>>>,
}

impl OutputFactory for CapsFactory {
    fn sample_rate(&mut self, _config: &OutputConfig) -> Result<u32, OutputError> {
        Ok(SHARED_RATE)
    }

    fn open(
        &mut self,
        config: &OutputConfig,
        request: OutputRequest,
        ring: rtrb::Consumer<f64>,
        _events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError> {
        let exclusive = config
            .exclusive
            .then_some(request.exclusive_source)
            .flatten()
            .and_then(|source| negotiate::choose(&self.caps, &source));
        let (rate, format) = exclusive.unwrap_or((SHARED_RATE, DeviceSampleFormat::Float32));
        let output = NullOutput::new(ring, rate, NullPacing::RealTime).with_format(OutputFormat {
            device_name: "test device".into(),
            sample_rate: rate,
            channels: 2,
            exclusive: exclusive.is_some(),
            bit_perfect: false,
            sample_format: Some(format),
            source_rate: None,
            resampled: false,
            exclusive_fallback: None,
        });
        self.opens.lock().unwrap().push((rate, exclusive.is_some()));
        *self.samples.lock().unwrap() = Some(output.sample_buffer());
        Ok(Box::new(output))
    }

    fn exclusive_format_for(
        &mut self,
        config: &OutputConfig,
        source: &SourceSpec,
    ) -> Option<(u32, DeviceSampleFormat)> {
        config
            .exclusive
            .then(|| negotiate::choose(&self.caps, source))
            .flatten()
    }
}

fn caps(rates: &[u32], formats: &[DeviceSampleFormat]) -> ExclusiveCaps {
    ExclusiveCaps {
        modes: rates
            .iter()
            .map(|&sample_rate| ExclusiveMode {
                sample_rate,
                formats: formats.to_vec(),
            })
            .collect(),
    }
}

struct Rig {
    engine: AudioEngine,
    events: Receiver<EngineEvent>,
    seen: Vec<EngineEvent>,
    opens: Arc<Mutex<Vec<(u32, bool)>>>,
    samples: Arc<Mutex<Option<NullSamples>>>,
}

fn rig(caps: ExclusiveCaps) -> Rig {
    let opens = Arc::new(Mutex::new(Vec::new()));
    let samples = Arc::new(Mutex::new(None));
    let cache = CacheConfig {
        dir: tmp_dir().join(format!("cache-{}", std::process::id())),
        max_bytes: 64 * 1024 * 1024,
    };
    let engine = AudioEngine::new(EngineInit {
        cache,
        output: Box::new(CapsFactory {
            caps,
            opens: opens.clone(),
            samples: samples.clone(),
        }),
    });
    engine.send(EngineCommand::SetOutput {
        config: OutputConfig {
            device_id: None,
            exclusive: true,
        },
    });
    let events = engine.events();
    Rig {
        engine,
        events,
        seen: Vec::new(),
        opens,
        samples,
    }
}

impl Rig {
    fn wait(&mut self, what: &str, done: impl Fn(&[EngineEvent]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done(&self.seen) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for {what}; events: {:#?}",
                self.seen
            );
            if let Ok(event) = self.events.recv_timeout(remaining) {
                self.seen.push(event);
            }
        }
    }

    fn recording(&self) -> Vec<f64> {
        self.samples
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.lock().clone())
            .unwrap_or_default()
    }

    fn opens(&self) -> Vec<(u32, bool)> {
        self.opens.lock().unwrap().clone()
    }

    /// Output formats reported while `id` was the current track (after its start).
    fn formats_after_start(&self, id: &str) -> Vec<OutputFormat> {
        let start = self
            .seen
            .iter()
            .position(|e| matches!(e, EngineEvent::TrackStarted { id: i, .. } if i == id))
            .unwrap_or(usize::MAX);
        self.seen
            .iter()
            .enumerate()
            .filter(|(i, _)| *i > start)
            .filter_map(|(_, e)| match e {
                EngineEvent::OutputChanged { format } => Some(format.clone()),
                _ => None,
            })
            .collect()
    }
}

fn ended(seen: &[EngineEvent], id: &str) -> bool {
    seen.iter()
        .any(|e| matches!(e, EngineEvent::TrackEnded { id: i, .. } if i == id))
}

fn started(seen: &[EngineEvent], id: &str) -> Option<Transition> {
    seen.iter().find_map(|e| match e {
        EngineEvent::TrackStarted {
            id: i, transition, ..
        } if i == id => Some(*transition),
        _ => None,
    })
}

fn tmp_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("engine-hires");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Sample layout of a test WAV file.
#[derive(Clone, Copy)]
enum Pcm {
    Int(u16),
    Float32,
}

/// Writes a stereo WAV with deterministic pseudo-random content (about −12 dBFS peak) and returns
/// the exact sample values as f64 (what a lossless path must reproduce).
fn write_wav(path: &Path, rate: u32, pcm: Pcm, seed: u64) -> Vec<f64> {
    let frames = (f64::from(rate) * TRACK_SECONDS) as usize;
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    let mut next = move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    };
    let (tag, bits) = match pcm {
        Pcm::Int(bits) => (1u16, bits),
        Pcm::Float32 => (3u16, 32),
    };
    let bytes_per_sample = usize::from(bits / 8);
    let mut data = Vec::with_capacity(frames * 2 * bytes_per_sample);
    let mut values = Vec::with_capacity(frames * 2);
    for _ in 0..frames * 2 {
        let x = 0.25 * next();
        match pcm {
            Pcm::Int(bits) => {
                let scale = (1i64 << (bits - 1)) as f64;
                let k = (x * scale).round() as i64;
                values.push(k as f64 / scale);
                data.extend_from_slice(&k.to_le_bytes()[..bytes_per_sample]);
            }
            Pcm::Float32 => {
                let v = x as f32;
                values.push(f64::from(v));
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    let block_align = 2 * bits / 8;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&tag.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&data);
    std::fs::write(path, wav).unwrap();
    values
}

fn wav_track(id: &str, rate: u32, pcm: Pcm, seed: u64) -> (TrackSource, Vec<f64>) {
    let label = match pcm {
        Pcm::Int(bits) => format!("i{bits}"),
        Pcm::Float32 => "f32".into(),
    };
    let path = tmp_dir().join(format!("{id}-{rate}-{label}.wav"));
    let values = write_wav(&path, rate, pcm, seed);
    let source = TrackSource {
        id: id.into(),
        location: SourceLocation::Local { path },
        gain: None,
        duration_hint_ms: None,
        album_key: None,
    };
    (source, values)
}

/// Asserts that `expected[from..from + len]` appears unchanged in `recording` (both interleaved
/// stereo). The start of a track is skipped by the caller (manual starts fade in over 10 ms).
fn assert_contains_exactly(
    recording: &[f64],
    expected: &[f64],
    from: usize,
    len: usize,
    what: &str,
) {
    let needle = &expected[from..from + len];
    let pos = recording
        .windows(4)
        .position(|w| w == &needle[..4])
        .unwrap_or_else(|| panic!("{what}: start of the reference block not found in the output"));
    let got = &recording[pos..(pos + len).min(recording.len())];
    assert_eq!(got.len(), len, "{what}: output too short");
    let mismatches = got.iter().zip(needle).filter(|(a, b)| a != b).count();
    assert_eq!(
        mismatches, 0,
        "{what}: {mismatches} of {len} samples differ"
    );
}

const ALL_RATES: [u32; 8] = [
    44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000,
];

#[test]
fn hi_res_sources_play_bit_exact_at_their_native_rate() {
    let cases = [
        ("s24-192", 192_000, Pcm::Int(24)),
        ("s24-176", 176_400, Pcm::Int(24)),
        ("s24-352", 352_800, Pcm::Int(24)),
        ("s32-384", 384_000, Pcm::Int(32)),
        ("f32-96", 96_000, Pcm::Float32),
    ];
    for (i, (id, rate, pcm)) in cases.into_iter().enumerate() {
        let mut r = rig(caps(
            &ALL_RATES,
            &[
                DeviceSampleFormat::Int32,
                DeviceSampleFormat::Int24In32,
                DeviceSampleFormat::Float32,
            ],
        ));
        let (track, values) = wav_track(id, rate, pcm, i as u64 + 1);
        r.engine.send(EngineCommand::Play {
            track,
            start_ms: 0,
            paused: false,
        });
        r.wait(id, |s| ended(s, id));

        let last_open = *r.opens().last().unwrap();
        assert_eq!(
            last_open,
            (rate, true),
            "{id}: device opened at the native rate"
        );
        let formats = r.formats_after_start(id);
        let format = formats.last().expect("output format reported");
        assert!(format.exclusive && !format.resampled, "{id}: {format:?}");
        assert_eq!(format.source_rate, Some(rate));
        assert!(
            format.bit_perfect,
            "{id}: reported as bit-perfect: {format:?}"
        );
        let expected_format = match pcm {
            Pcm::Float32 => DeviceSampleFormat::Float32,
            Pcm::Int(_) => DeviceSampleFormat::Int32,
        };
        assert_eq!(format.sample_format, Some(expected_format));

        // Skip the first 50 ms (fade-in of a manual start), compare 100 ms.
        let from = (f64::from(rate) * 0.05) as usize * 2;
        let len = (f64::from(rate) * 0.1) as usize * 2;
        assert_contains_exactly(&r.recording(), &values, from, len, id);
    }
}

#[test]
fn unsupported_native_rate_stays_exclusive_at_the_best_rate() {
    // 352.8 kHz on a device without the 44.1 kHz multiples above 44.1 kHz: same family first.
    let mut r = rig(caps(
        &[44_100, 48_000, 96_000, 192_000],
        &[DeviceSampleFormat::Int24In32],
    ));
    let (track, _) = wav_track("dxd", 352_800, Pcm::Int(24), 7);
    r.engine.send(EngineCommand::Play {
        track,
        start_ms: 0,
        paused: false,
    });
    r.wait("dxd", |s| ended(s, "dxd"));
    assert_eq!(*r.opens().last().unwrap(), (44_100, true));
    let format = r.formats_after_start("dxd").last().cloned().unwrap();
    assert!(
        format.exclusive && format.resampled && !format.bit_perfect,
        "{format:?}"
    );
    assert_eq!(format.source_rate, Some(352_800));
}

#[test]
fn rate_change_between_tracks_reopens_the_device_and_keeps_both_bit_exact() {
    let mut r = rig(caps(&ALL_RATES, &[DeviceSampleFormat::Int32]));
    let (a, _) = wav_track("a96", 96_000, Pcm::Int(24), 11);
    let (b, b_values) = wav_track("b192", 192_000, Pcm::Int(24), 12);
    r.engine.send(EngineCommand::Play {
        track: a,
        start_ms: 0,
        paused: false,
    });
    r.engine.send(EngineCommand::SetNext { track: Some(b) });
    r.wait("b192", |s| ended(s, "b192"));

    assert_eq!(started(&r.seen, "a96"), Some(Transition::Manual));
    assert_eq!(started(&r.seen, "b192"), Some(Transition::Gapless));
    let opens = r.opens();
    let a_at = opens
        .iter()
        .position(|&o| o == (96_000, true))
        .expect("opened at 96 kHz");
    assert!(
        opens[a_at..].contains(&(192_000, true)),
        "reopened at 192 kHz for the next track: {opens:?}"
    );
    let format = r.formats_after_start("b192").last().cloned().unwrap();
    assert!(
        format.bit_perfect && format.sample_rate == 192_000,
        "{format:?}"
    );
    // The reopened stream starts B unfaded: its very first samples are exact.
    let len = (192_000.0 * 0.1) as usize * 2;
    assert_contains_exactly(
        &r.recording(),
        &b_values,
        0,
        len,
        "b192 from its first sample",
    );
}

#[test]
fn dsp_keeps_exclusive_mode_but_is_not_bit_perfect() {
    let mut r = rig(caps(&ALL_RATES, &[DeviceSampleFormat::Int32]));
    let (track, _) = wav_track("eq96", 96_000, Pcm::Int(24), 21);
    r.engine.send(EngineCommand::Play {
        track,
        start_ms: 0,
        paused: false,
    });
    r.wait("start", |s| started(s, "eq96").is_some());
    let opens_before = r.opens().len();
    r.engine.send(EngineCommand::SetDsp {
        config: DspConfig {
            eq: EqConfig {
                enabled: true,
                preamp_db: 0.0,
                auto_headroom: true,
                mode: EqMode::Graphic {
                    bands: GraphicBands::Ten,
                    gains_db: vec![3.0; 10],
                },
            },
            ..DspConfig::default()
        },
    });
    r.wait("eq96 end", |s| ended(s, "eq96"));
    let last = r.formats_after_start("eq96").last().cloned().unwrap();
    assert!(last.exclusive && last.sample_rate == 96_000, "{last:?}");
    assert!(!last.bit_perfect, "EQ on → not bit-perfect");
    assert_eq!(
        r.opens().len(),
        opens_before,
        "no reopen when the DSP changes"
    );
}

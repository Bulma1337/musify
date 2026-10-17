//! Measures a crossfade through the whole engine: two tones of different frequency (uncorrelated)
//! crossfaded with an equal-power curve must keep the level constant (no dip, no bump, no click),
//! also when the app queues the next track while the fade runs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use musify_audio::api::{
    CrossfadeConfig, EngineCommand, EngineEvent, OutputConfig, SourceLocation, TrackSource,
    Transition,
};
use musify_audio::engine::OutputFactory;
use musify_audio::output::null::{NullOutput, NullPacing, NullSamples};
use musify_audio::output::{OutputError, OutputEvent, OutputRequest, OutputStream};
use musify_audio::source::CacheConfig;
use musify_audio::{AudioEngine, EngineInit};

const RATE: u32 = 44_100;
const AMPLITUDE: f64 = 0.25;

struct NullFactory {
    samples: Arc<Mutex<Option<NullSamples>>>,
}

impl OutputFactory for NullFactory {
    fn sample_rate(&mut self, _config: &OutputConfig) -> Result<u32, OutputError> {
        Ok(RATE)
    }

    fn open(
        &mut self,
        _config: &OutputConfig,
        _request: OutputRequest,
        ring: rtrb::Consumer<f64>,
        _events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError> {
        let output = NullOutput::new(ring, RATE, NullPacing::RealTime);
        *self.samples.lock().unwrap() = Some(output.sample_buffer());
        Ok(Box::new(output))
    }
}

fn tmp_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("engine-crossfade");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 16-bit stereo WAV with a sine of `freq` Hz for `seconds`.
fn write_sine(path: &Path, freq: f64, seconds: f64) {
    let frames = (f64::from(RATE) * seconds) as usize;
    let mut data = Vec::with_capacity(frames * 4);
    for i in 0..frames {
        let v = (AMPLITUDE
            * (2.0 * std::f64::consts::PI * freq * i as f64 / f64::from(RATE)).sin()
            * 32767.0)
            .round() as i16;
        data.extend_from_slice(&v.to_le_bytes());
        data.extend_from_slice(&v.to_le_bytes());
    }
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * 4).to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&data);
    std::fs::write(path, wav).unwrap();
}

fn sine_track(id: &str, freq: f64, seconds: f64) -> TrackSource {
    let path = tmp_dir().join(format!("{id}-{freq}.wav"));
    write_sine(&path, freq, seconds);
    TrackSource {
        id: id.into(),
        location: SourceLocation::Local { path },
        gain: None,
        duration_hint_ms: None,
        album_key: None,
    }
}

#[test]
fn crossfade_keeps_the_level_constant_while_the_next_track_is_queued() {
    let samples = Arc::new(Mutex::new(None));
    let engine = AudioEngine::new(EngineInit {
        cache: CacheConfig {
            dir: tmp_dir().join(format!("cache-{}", std::process::id())),
            max_bytes: 16 * 1024 * 1024,
        },
        output: Box::new(NullFactory {
            samples: samples.clone(),
        }),
    });
    let events = engine.events();
    engine.send(EngineCommand::SetCrossfade {
        config: CrossfadeConfig {
            duration_ms: 400,
            skip_same_album: false,
        },
    });
    engine.send(EngineCommand::Play {
        track: sine_track("a", 1000.0, 1.2),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(sine_track("b", 1500.0, 1.2)),
    });

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut queued_c = false;
    while !seen
        .iter()
        .any(|e| matches!(e, EngineEvent::TrackEnded { id, .. } if id == "b"))
    {
        assert!(Instant::now() < deadline, "timed out: {seen:#?}");
        if let Ok(e) = events.recv_timeout(Duration::from_millis(50)) {
            if !queued_c && matches!(&e, EngineEvent::TrackStarted { id, .. } if id == "b") {
                // The app queues the track after next as soon as b starts.
                engine.send(EngineCommand::SetNext {
                    track: Some(sine_track("c", 700.0, 1.2)),
                });
                queued_c = true;
            }
            seen.push(e);
        }
    }
    assert!(seen.iter().any(|e| matches!(e, EngineEvent::TrackStarted { id, transition: Transition::Crossfade, .. } if id == "b")));

    let rec = samples.lock().unwrap().as_ref().unwrap().lock().clone();
    let left: Vec<f64> = rec.iter().step_by(2).copied().collect();
    // Steady level of one tone: RMS of a sine = A/√2.
    let steady = AMPLITUDE / 2f64.sqrt();
    // From 150 ms in (after the manual fade-in) until 300 ms before c could start, measure RMS in
    // 10 ms windows. The a→b crossfade sits in the middle of this range.
    let first_audible = left.iter().position(|v| v.abs() > 1e-4).expect("audio");
    let from = first_audible + (0.15 * f64::from(RATE)) as usize;
    let to = first_audible + (1.6 * f64::from(RATE)) as usize;
    let window = (0.01 * f64::from(RATE)) as usize;
    let mut worst_low: f64 = 0.0;
    let mut worst_high: f64 = 0.0;
    for w in left[from..to.min(left.len())].chunks(window) {
        let rms = (w.iter().map(|v| v * v).sum::<f64>() / w.len() as f64).sqrt();
        let db = 20.0 * (rms / steady).log10();
        worst_low = worst_low.min(db);
        worst_high = worst_high.max(db);
    }
    println!("crossfade level: {worst_low:+.2} dB … {worst_high:+.2} dB");
    assert!(
        worst_low > -1.0,
        "dip of {worst_low:.2} dB during the crossfade"
    );
    assert!(
        worst_high < 1.0,
        "bump of {worst_high:.2} dB during the crossfade"
    );
    // No click: the largest sample-to-sample step stays close to that of the tones themselves
    // (a 1.5 kHz sine at 0.25 changes by at most 2π·1500/44100·0.25 ≈ 0.053 per sample).
    let max_step = left[from..to.min(left.len())]
        .windows(2)
        .map(|p| (p[1] - p[0]).abs())
        .fold(0.0, f64::max);
    assert!(max_step < 0.08, "discontinuity of {max_step:.3}");
}

/// Amplitude of `freq` in `w` (Goertzel). Windows hold whole periods, so the other tone does not
/// leak into it.
fn tone_amplitude(w: &[f64], freq: f64) -> f64 {
    let coeff = 2.0 * (2.0 * std::f64::consts::PI * freq / f64::from(RATE)).cos();
    let (mut s1, mut s2) = (0.0, 0.0);
    for &x in w {
        let s = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    2.0 * power.max(0.0).sqrt() / w.len() as f64
}

/// Plays a 1.2 s tone (album `album_a`) followed by a 1.2 s tone (album `album_b`) and returns when
/// the second one becomes audible, in seconds after the first one started, and its transition.
fn next_track_onset(
    crossfade_ms: u32,
    skip_same_album: bool,
    album_a: Option<&str>,
    album_b: Option<&str>,
) -> (f64, Transition) {
    // Tests run in parallel: every run gets its own files.
    static RUN: AtomicUsize = AtomicUsize::new(0);
    let run = RUN.fetch_add(1, Ordering::Relaxed);
    let (a, b) = (format!("onset{run}-a"), format!("onset{run}-b"));
    let samples = Arc::new(Mutex::new(None));
    let engine = AudioEngine::new(EngineInit {
        cache: CacheConfig {
            dir: tmp_dir().join(format!("cache-onset{run}-{}", std::process::id())),
            max_bytes: 16 * 1024 * 1024,
        },
        output: Box::new(NullFactory {
            samples: samples.clone(),
        }),
    });
    let events = engine.events();
    engine.send(EngineCommand::SetCrossfade {
        config: CrossfadeConfig {
            duration_ms: crossfade_ms,
            skip_same_album,
        },
    });
    let track = |id: &str, freq: f64, album: Option<&str>| TrackSource {
        album_key: album.map(Into::into),
        ..sine_track(id, freq, 1.2)
    };
    engine.send(EngineCommand::Play {
        track: track(&a, 1000.0, album_a),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(track(&b, 1500.0, album_b)),
    });

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut transition = None;
    loop {
        assert!(Instant::now() < deadline, "timed out");
        match events.recv_timeout(Duration::from_millis(50)) {
            Ok(EngineEvent::TrackStarted {
                id, transition: t, ..
            }) if id == b => {
                transition = Some(t);
            }
            Ok(EngineEvent::TrackEnded { id, .. }) if id == b => break,
            _ => {}
        }
    }

    let rec = samples.lock().unwrap().as_ref().unwrap().lock().clone();
    let left: Vec<f64> = rec.iter().step_by(2).copied().collect();
    let first_audible = left.iter().position(|v| v.abs() > 1e-4).expect("audio");
    // 10 ms windows: 10 periods of a, 15 of b. b counts as audible from −40 dB of its full level.
    // The search starts after the fade-in at the start, which smears a's spectrum.
    let window = (0.01 * f64::from(RATE)) as usize;
    let skip = 10;
    let onset = left[first_audible..]
        .chunks_exact(window)
        .skip(skip)
        .position(|w| tone_amplitude(w, 1500.0) > AMPLITUDE * 0.01)
        .expect("second track audible")
        + skip;
    (
        (onset * window) as f64 / f64::from(RATE),
        transition.expect("b started"),
    )
}

#[test]
fn crossfade_starts_the_next_track_that_long_before_the_end() {
    // 1.2 s track, 400 ms crossfade: the next track comes in at 0.8 s.
    let (onset, transition) = next_track_onset(400, false, None, None);
    println!("crossfade 400 ms: next track audible at {onset:.3} s");
    assert_eq!(transition, Transition::Crossfade);
    assert!((onset - 0.8).abs() <= 0.015, "next track at {onset:.3} s");

    // Same album, but crossfading within albums is allowed (the default).
    let (onset, transition) = next_track_onset(400, false, Some("album"), Some("album"));
    assert_eq!(transition, Transition::Crossfade);
    assert!(
        (onset - 0.8).abs() <= 0.015,
        "album: next track at {onset:.3} s"
    );

    // Tracks of different albums are crossfaded even when album tracks should stay gapless.
    let (onset, transition) = next_track_onset(400, true, Some("one"), Some("two"));
    assert_eq!(transition, Transition::Crossfade);
    assert!(
        (onset - 0.8).abs() <= 0.015,
        "other album: next track at {onset:.3} s"
    );
}

#[test]
fn album_tracks_stay_gapless_when_asked_to() {
    let (onset, transition) = next_track_onset(400, true, Some("album"), Some("album"));
    println!("same album, no crossfade: next track audible at {onset:.3} s");
    assert_eq!(transition, Transition::Gapless);
    assert!((onset - 1.2).abs() <= 0.015, "next track at {onset:.3} s");
}

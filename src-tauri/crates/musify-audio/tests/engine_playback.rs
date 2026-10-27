//! End-to-end tests of the whole engine (controller → workers → mixer → DSP → output) against a null
//! output device running in real time.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use musify_audio::api::{
    CrossfadeConfig, EngineCommand, EngineEvent, OutputConfig, PlaybackState, SourceLocation,
    TrackSource, Transition,
};
use musify_audio::engine::OutputFactory;
use musify_audio::output::null::{NullOutput, NullPacing, NullSamples};
use musify_audio::output::{OutputError, OutputEvent, OutputRequest, OutputStream};
use musify_audio::source::CacheConfig;
use musify_audio::{AudioEngine, EngineInit};

const RATE: u32 = 44_100;
/// Frames of the gapless source and where it was split (see tests/fixtures/decode/generate.ps1).
const SRC_FRAMES: usize = 66_150;

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

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("decode")
        .join(name)
}

fn track(id: &str, file: &str, album: Option<&str>) -> TrackSource {
    TrackSource {
        id: id.into(),
        location: SourceLocation::Local {
            path: fixture(file),
        },
        gain: None,
        duration_hint_ms: None,
        album_key: album.map(Into::into),
    }
}

fn engine() -> (AudioEngine, Arc<Mutex<Option<NullSamples>>>) {
    let samples = Arc::new(Mutex::new(None));
    let cache = CacheConfig {
        dir: PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("engine-cache-{}", std::process::id())),
        max_bytes: 64 * 1024 * 1024,
    };
    let engine = AudioEngine::new(EngineInit {
        cache,
        output: Box::new(NullFactory {
            samples: samples.clone(),
        }),
    });
    (engine, samples)
}

/// Collects events until `done` returns true (or the timeout hits).
fn wait_for(
    events: &Receiver<EngineEvent>,
    seen: &mut Vec<EngineEvent>,
    timeout: Duration,
    done: impl Fn(&[EngineEvent]) -> bool,
) {
    let deadline = Instant::now() + timeout;
    while !done(seen) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out; events so far: {seen:#?}");
        if let Ok(event) = events.recv_timeout(remaining) {
            seen.push(event);
        }
    }
}

fn ended(seen: &[EngineEvent], id: &str) -> bool {
    seen.iter()
        .any(|e| matches!(e, EngineEvent::TrackEnded { id: i, .. } if i == id))
}

/// Decodes the 16-bit PCM WAV source into interleaved f64 (exact for 16-bit values).
fn source_samples() -> Vec<f64> {
    let bytes = std::fs::read(fixture("gapless_src.wav")).unwrap();
    let data = bytes
        .windows(4)
        .position(|w| w == b"data")
        .expect("data chunk")
        + 8;
    bytes[data..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| f64::from(i16::from_le_bytes(*b)) / 32768.0)
        .collect()
}

#[test]
fn gapless_flac_parts_reproduce_the_source_bit_exactly() {
    let (engine, samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();

    engine.send(EngineCommand::Play {
        track: track("p1", "gapless_p1.flac", Some("suite")),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(track("p2", "gapless_p2.flac", Some("suite"))),
    });
    wait_for(&events, &mut seen, Duration::from_secs(10), |s| {
        ended(s, "p2")
    });

    // Events: p1 manual start, p2 gapless start, both completed.
    assert!(seen.iter().any(|e| matches!(e, EngineEvent::TrackStarted { id, transition: Transition::Manual, .. } if id == "p1")));
    assert!(seen.iter().any(|e| matches!(e, EngineEvent::TrackStarted { id, transition: Transition::Gapless, .. } if id == "p2")));
    for id in ["p1", "p2"] {
        assert!(
            seen.iter().any(
                |e| matches!(e, EngineEvent::TrackEnded { id: i, completed: true, .. } if i == id)
            ),
            "{id} not completed"
        );
    }
    std::thread::sleep(Duration::from_millis(300));

    let recorded = samples.lock().unwrap().as_ref().unwrap().lock().clone();
    let source = source_samples();
    assert_eq!(source.len(), SRC_FRAMES * 2);

    // Align on a stretch well after the 10 ms fade-in of the manual start (frame 4000 ≈ 90 ms), then
    // compare everything from there to the end — including the joint between the two files.
    let anchor = 2 * 4000;
    let offset = (0..recorded.len().saturating_sub(source.len()))
        .find(|&o| recorded[o + anchor..o + anchor + 128] == source[anchor..anchor + 128])
        .expect("source not found in output");
    let skip = 2 * 2000;
    let mismatches = (skip..source.len())
        .filter(|&i| recorded[offset + i] != source[i])
        .count();
    assert_eq!(
        mismatches, 0,
        "output differs from the source in {mismatches} samples"
    );
}

#[test]
fn seek_continues_the_same_track_and_counts_played_time() {
    let (engine, _samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();

    engine.send(EngineCommand::Play {
        track: track("full", "gapless_full.flac", None),
        start_ms: 0,
        paused: false,
    });
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        s.iter()
            .any(|e| matches!(e, EngineEvent::Position { position_ms, .. } if *position_ms >= 200))
    });
    engine.send(EngineCommand::Seek { position_ms: 1_000 });
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        ended(s, "full")
    });

    let starts = seen
        .iter()
        .filter(|e| matches!(e, EngineEvent::TrackStarted { .. }))
        .count();
    assert_eq!(starts, 1, "a seek must not announce a new track");
    let after_seek = seen.iter().rev().find_map(|e| match e {
        EngineEvent::Position { position_ms, .. } => Some(*position_ms),
        _ => None,
    });
    assert!(after_seek.unwrap() >= 1_000);
    let played = seen.iter().find_map(|e| match e {
        EngineEvent::TrackEnded { played_ms, .. } => Some(*played_ms),
        _ => None,
    });
    // ≈ 200+ ms before the seek plus ≈ 500 ms after it.
    let played = played.unwrap();
    assert!((600..=1_200).contains(&played), "played_ms = {played}");
}

#[test]
fn crossfade_between_albums_and_stop_at_the_end() {
    let (engine, _samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();

    engine.send(EngineCommand::SetCrossfade {
        config: CrossfadeConfig {
            duration_ms: 400,
            skip_same_album: true,
        },
    });
    engine.send(EngineCommand::Play {
        track: track("a", "gapless_p1.flac", Some("album-a")),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(track("b", "gapless_p2.mp3", Some("album-b"))),
    });
    wait_for(&events, &mut seen, Duration::from_secs(10), |s| {
        ended(s, "b")
    });

    assert!(seen.iter().any(|e| matches!(e, EngineEvent::TrackStarted { id, transition: Transition::Crossfade, .. } if id == "b")));
    wait_for(&events, &mut seen, Duration::from_secs(3), |s| {
        s.iter().any(|e| {
            matches!(
                e,
                EngineEvent::StateChanged {
                    state: PlaybackState::Stopped
                }
            )
        })
    });
}

/// The app queues the track after next as soon as a crossfade announces the next one. That must not
/// disturb the crossfade in progress: b plays completely, then crossfades into c.
#[test]
fn queueing_during_a_crossfade_keeps_the_incoming_track() {
    let (engine, _samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();

    engine.send(EngineCommand::SetCrossfade {
        config: CrossfadeConfig {
            duration_ms: 300,
            skip_same_album: false,
        },
    });
    engine.send(EngineCommand::Play {
        track: track("a", "gapless_p1.flac", Some("album")),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(track("b", "gapless_p2.flac", Some("album"))),
    });
    wait_for(&events, &mut seen, Duration::from_secs(10), |s| {
        s.iter()
            .any(|e| matches!(e, EngineEvent::TrackStarted { id, .. } if id == "b"))
    });
    // Like the app: queue the next track right away.
    engine.send(EngineCommand::SetNext {
        track: Some(track("c", "gapless_p1.flac", Some("album"))),
    });
    wait_for(&events, &mut seen, Duration::from_secs(10), |s| {
        ended(s, "c")
    });

    let started = |id: &str| {
        seen.iter().find_map(|e| match e {
            EngineEvent::TrackStarted {
                id: i, transition, ..
            } if i == id => Some(*transition),
            _ => None,
        })
    };
    assert_eq!(started("b"), Some(Transition::Crossfade));
    assert_eq!(
        started("c"),
        Some(Transition::Crossfade),
        "b crossfades into c"
    );
    let played = |id: &str| {
        seen.iter().find_map(|e| match e {
            EngineEvent::TrackEnded {
                id: i,
                played_ms,
                completed,
            } if i == id => Some((*played_ms, *completed)),
            _ => None,
        })
    };
    // gapless_p2 is ~750 ms long: it must have played (nearly) completely, not been replaced by c.
    let (b_ms, b_done) = played("b").expect("b ended");
    assert!(b_done, "b completed");
    assert!(b_ms >= 650, "b played {b_ms} ms");
    // Each track starts once; b's start comes before a ends, c's before b ends.
    let pos = |pred: &dyn Fn(&EngineEvent) -> bool| seen.iter().position(pred).unwrap();
    let b_start = pos(&|e| matches!(e, EngineEvent::TrackStarted { id, .. } if id == "b"));
    let a_end = pos(&|e| matches!(e, EngineEvent::TrackEnded { id, .. } if id == "a"));
    let c_start = pos(&|e| matches!(e, EngineEvent::TrackStarted { id, .. } if id == "c"));
    let b_end = pos(&|e| matches!(e, EngineEvent::TrackEnded { id, .. } if id == "b"));
    assert!(
        b_start < a_end && a_end < c_start && c_start < b_end,
        "{seen:#?}"
    );
    // Positions keep coming for the incoming track during the crossfade (no frozen progress bar).
    let b_positions = seen[b_start..a_end]
        .iter()
        .filter(|e| matches!(e, EngineEvent::Position { id, .. } if id == "b"))
        .count();
    assert!(b_positions >= 1, "positions for b during the crossfade");
}

#[test]
fn pause_and_resume_report_state() {
    let (engine, _samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();

    engine.send(EngineCommand::Play {
        track: track("full", "gapless_full.flac", None),
        start_ms: 0,
        paused: false,
    });
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        s.iter().any(|e| {
            matches!(
                e,
                EngineEvent::StateChanged {
                    state: PlaybackState::Playing
                }
            )
        })
    });
    engine.send(EngineCommand::Pause);
    wait_for(&events, &mut seen, Duration::from_secs(2), |s| {
        s.iter().any(|e| {
            matches!(
                e,
                EngineEvent::StateChanged {
                    state: PlaybackState::Paused
                }
            )
        })
    });
    engine.send(EngineCommand::Resume);
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        ended(s, "full")
    });
}

/// A next track that cannot be opened (here: a server error document saved as audio) is reported
/// once. Offering the same track again must not start an error loop; another track still follows.
#[test]
fn a_broken_next_track_is_reported_once_and_not_retried() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("engine-broken-next");
    std::fs::create_dir_all(&dir).unwrap();
    let gone = dir.join("gone.mp3");
    std::fs::write(
        &gone,
        br#"{"subsonic-response":{"status":"failed","error":{"code":70,"message":"data not found"}}}"#,
    )
    .unwrap();
    let broken = TrackSource {
        id: "broken".into(),
        location: SourceLocation::Local { path: gone },
        gain: None,
        duration_hint_ms: None,
        album_key: None,
    };

    let (engine, _samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();
    engine.send(EngineCommand::Play {
        track: track("a", "gapless_full.flac", None),
        start_ms: 0,
        paused: false,
    });
    engine.send(EngineCommand::SetNext {
        track: Some(broken.clone()),
    });
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        s.iter()
            .any(|e| matches!(e, EngineEvent::NeedNext { id } if id == "a"))
    });
    // What the app did on NeedNext before it skipped broken tracks: offer the same one again.
    engine.send(EngineCommand::SetNext {
        track: Some(broken.clone()),
    });
    engine.send(EngineCommand::SetNext {
        track: Some(broken),
    });
    engine.send(EngineCommand::SetNext {
        track: Some(track("b", "gapless_p2.flac", None)),
    });
    wait_for(&events, &mut seen, Duration::from_secs(10), |s| {
        ended(s, "b")
    });

    let errors = seen
        .iter()
        .filter(|e| matches!(e, EngineEvent::Error { id: Some(id), .. } if id == "broken"))
        .count();
    assert_eq!(errors, 1, "events: {seen:#?}");
    assert!(
        seen.iter()
            .any(|e| matches!(e, EngineEvent::TrackStarted { id, .. } if id == "b"))
    );
}

/// Writes a 16-bit stereo WAV of `frames` frames whose samples are `f(frame)`.
fn write_wav(path: &std::path::Path, frames: usize, f: impl Fn(usize) -> f64) {
    let data_len = (frames * 4) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&RATE.to_le_bytes());
    bytes.extend_from_slice(&(RATE * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        let v = (f(i).clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&v.to_le_bytes());
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, bytes).unwrap();
}

/// Switching tracks by hand stops the old one at once. Before, the ~50 ms the mixer keeps queued
/// for the device (plus its own 10 ms fade) were still played after the switch.
#[test]
fn a_manual_switch_stops_the_old_track_within_a_few_milliseconds() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("engine-switch");
    std::fs::create_dir_all(&dir).unwrap();
    let tone = dir.join("tone.wav");
    let silence = dir.join("silence.wav");
    let frames = RATE as usize * 3;
    write_wav(&tone, frames, |i| {
        0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / f64::from(RATE)).sin()
    });
    write_wav(&silence, frames, |_| 0.0);
    let local = |id: &str, path: &std::path::Path| TrackSource {
        id: id.into(),
        location: SourceLocation::Local {
            path: path.to_path_buf(),
        },
        gain: None,
        duration_hint_ms: None,
        album_key: None,
    };

    let (engine, samples) = engine();
    let events = engine.events();
    let mut seen = Vec::new();
    engine.send(EngineCommand::Play {
        track: local("tone", &tone),
        start_ms: 0,
        paused: false,
    });
    wait_for(&events, &mut seen, Duration::from_secs(5), |s| {
        s.iter()
            .any(|e| matches!(e, EngineEvent::Position { id, position_ms, .. } if id == "tone" && *position_ms > 400))
    });
    let output = samples.lock().unwrap().as_ref().unwrap().clone();
    // Output time of the switch: everything rendered until now.
    let switch_at = output.lock().len() / 2;
    engine.send(EngineCommand::Play {
        track: local("silence", &silence),
        start_ms: 0,
        paused: false,
    });
    std::thread::sleep(Duration::from_millis(400));

    let recorded = output.lock().clone();
    let frames_recorded = recorded.len() / 2;
    assert!(
        frames_recorded > switch_at + RATE as usize / 4,
        "output kept running"
    );
    let last_tone = (switch_at..frames_recorded)
        .rev()
        .find(|&f| recorded[2 * f].abs() > 1e-9)
        .unwrap_or(switch_at);
    let tail_ms = (last_tone - switch_at) as f64 * 1000.0 / f64::from(RATE);
    // One null-output block (512 frames ≈ 11.6 ms) until the mixer's cut is seen, plus the 5 ms fade
    // and scheduling slack. Without the cut this is 60 ms or more.
    assert!(
        tail_ms < 30.0,
        "old track still audible for {tail_ms:.1} ms after the switch"
    );
    // And it fades instead of breaking off: no jump at its end.
    let end = &recorded[2 * last_tone.saturating_sub(8)..2 * (last_tone + 1)];
    assert!(end.iter().all(|s| s.abs() < 0.05), "abrupt end: {end:?}");
}

//! TrackWorker end-to-end with local files: events, frame positions, samples identical to
//! Decoder + Conformer, prompt stop on drop.

mod decode_support;

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, unbounded};
use decode_support::*;
use musify_audio::decode::{Conformer, TrackWorker, TrackWorkerConfig, WorkerEvent};
use musify_audio::source::{OpenedSource, SourceError};

fn opener(
    name: &'static str,
    starts_at_ms: u64,
) -> Box<dyn FnOnce() -> Result<OpenedSource, SourceError> + Send> {
    Box::new(move || {
        let src = FileSource::open(&fixture(name))?;
        Ok(OpenedSource {
            source: Box::new(src),
            starts_at_ms,
        })
    })
}

/// Reference: Decoder (seeked to `seek_ms`) + Conformer, all at once.
fn reference(name: &str, seek_ms: u64, dst: u32) -> Vec<f64> {
    let mut d = open(name);
    if seek_ms > 0 {
        d.seek(seek_ms).unwrap();
    }
    let mut c = Conformer::with_layout(d.sample_rate(), d.channel_layout(), dst);
    let native = decode_all(&mut d);
    let mut out = Vec::new();
    c.process(&native, &mut out);
    c.flush(&mut out);
    out
}

/// Pops the ring until `Finished` arrived and the ring is drained. Returns (samples, events).
fn collect(
    mut ring: rtrb::Consumer<f64>,
    events: &Receiver<WorkerEvent>,
) -> (Vec<f64>, Vec<WorkerEvent>) {
    let mut samples = Vec::new();
    let mut evs = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        while let Ok(s) = ring.pop() {
            samples.push(s);
        }
        while let Ok(ev) = events.try_recv() {
            evs.push(ev);
        }
        let done = evs
            .iter()
            .any(|e| matches!(e, WorkerEvent::Finished { .. } | WorkerEvent::Error { .. }));
        if done && ring.is_empty() {
            return (samples, evs);
        }
        assert!(Instant::now() < deadline, "worker timed out");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn run(
    name: &'static str,
    starts_at_ms: u64,
    start_ms: u64,
    dst: u32,
    ring_frames: usize,
) -> (Vec<f64>, Vec<WorkerEvent>) {
    let (tx, rx) = unbounded();
    let config = TrackWorkerConfig {
        dst_rate: dst,
        ring_frames,
        start_ms,
    };
    let (worker, ring) = TrackWorker::spawn(
        "slot-1".into(),
        opener(name, starts_at_ms),
        super_hint(name),
        config,
        tx,
    );
    assert_eq!(worker.id(), "slot-1");
    let r = collect(ring, &rx);
    drop(worker);
    r
}

fn super_hint(name: &str) -> Option<String> {
    hint_for(name)
}

#[test]
fn plays_whole_track_with_resampling() {
    // 66150 frames @ 44.1 kHz → exactly 72000 frames @ 48 kHz. Small ring: the worker has to wait.
    let (samples, evs) = run("gapless_full.flac", 0, 0, 48000, 2048);
    let expect = reference("gapless_full.flac", 0, 48000);
    assert_eq!(samples.len(), 72000 * 2);
    assert!(
        samples == expect,
        "ring samples equal Decoder + Conformer output"
    );
    match &evs[..] {
        [
            WorkerEvent::Ready {
                id,
                info,
                start_frame: 0,
            },
            WorkerEvent::Finished {
                id: id2,
                end_frame: 72000,
            },
        ] => {
            assert_eq!(id, "slot-1");
            assert_eq!(id2, "slot-1");
            assert_eq!(info.n_frames, Some(66150));
        }
        other => panic!("unexpected events {other:?}"),
    }
}

#[test]
fn same_rate_is_bit_exact() {
    let (samples, evs) = run("gapless_full.alac.m4a", 0, 0, 44100, 4096);
    let (src, _, _) = read_wav16("gapless_src.wav");
    assert!(
        samples == src,
        "ALAC through the worker is bit-identical to the source"
    );
    assert!(matches!(
        evs.last(),
        Some(WorkerEvent::Finished {
            end_frame: 66150,
            ..
        })
    ));
}

#[test]
fn starts_at_position() {
    // 500 ms into a 44.1 kHz file, device at 48 kHz: first ring sample is device frame 24000.
    let (samples, evs) = run("gapless_full.flac", 0, 500, 48000, 8192);
    let expect = reference("gapless_full.flac", 500, 48000);
    assert!(samples == expect);
    assert!(
        matches!(
            evs[0],
            WorkerEvent::Ready {
                start_frame: 24000,
                ..
            }
        ),
        "{:?}",
        evs[0]
    );
    let n = (samples.len() / 2) as u64;
    assert!(matches!(evs[1], WorkerEvent::Finished { end_frame, .. } if end_frame == 24000 + n));
}

#[test]
fn source_that_already_starts_later() {
    // A transcode restarted at 1000 ms: stream time 0 = track time 1000 ms. Starting at 1200 ms
    // fine-seeks 200 ms into the stream; positions are absolute track positions.
    let (samples, evs) = run("gapless_full.flac", 1000, 1200, 48000, 8192);
    let expect = reference("gapless_full.flac", 200, 48000);
    assert!(samples == expect);
    assert!(
        matches!(
            evs[0],
            WorkerEvent::Ready {
                start_frame: 57600,
                ..
            }
        ),
        "{:?}",
        evs[0]
    );
}

#[test]
fn surround_and_mono_are_conformed() {
    let (samples, _) = run("surround51.flac", 0, 0, 48000, 4096);
    assert!(samples == reference("surround51.flac", 0, 48000));
    let (samples, _) = run("mono.flac", 0, 0, 48000, 4096);
    assert!(samples.as_chunks::<2>().0.iter().all(|[l, r]| l == r));
    assert_eq!(samples.len(), 24000 * 2);
}

#[test]
fn errors_are_reported() {
    // Source error from `open`.
    let (tx, rx) = unbounded();
    let cfg = TrackWorkerConfig {
        dst_rate: 48000,
        ring_frames: 1024,
        start_ms: 0,
    };
    let (_w, _ring) = TrackWorker::spawn(
        "a".into(),
        Box::new(|| Err(SourceError::Http(404))),
        None,
        cfg.clone(),
        tx.clone(),
    );
    let ev = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        matches!(&ev, WorkerEvent::Error { id, .. } if id == "a"),
        "{ev:?}"
    );

    // Undecodable data.
    let (_w, _ring) = TrackWorker::spawn(
        "b".into(),
        opener("garbage.mp3", 0),
        Some("mp3".into()),
        cfg.clone(),
        tx.clone(),
    );
    let ev = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        matches!(&ev, WorkerEvent::Error { id, .. } if id == "b"),
        "{ev:?}"
    );

    // A panic inside the worker is caught and reported.
    let (_w, _ring) = TrackWorker::spawn("c".into(), Box::new(|| panic!("boom")), None, cfg, tx);
    let ev = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    match ev {
        WorkerEvent::Error { id, error } => {
            assert_eq!(id, "c");
            assert!(error.to_string().contains("boom"), "{error}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn drop_stops_the_thread_promptly() {
    let (tx, rx) = unbounded();
    let cfg = TrackWorkerConfig {
        dst_rate: 48000,
        ring_frames: 256,
        start_ms: 0,
    };
    let (worker, ring) = TrackWorker::spawn(
        "d".into(),
        opener("gapless_full.flac", 0),
        Some("flac".into()),
        cfg,
        tx,
    );
    // Wait until it is running and blocked on the full ring.
    let ev = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(ev, WorkerEvent::Ready { .. }));
    assert!(worker.is_running());
    let t = Instant::now();
    drop(worker);
    assert!(
        t.elapsed() < Duration::from_millis(5),
        "drop must not block"
    );
    // The thread exits and drops its event sender: the channel disconnects without Finished.
    match rx.recv_timeout(Duration::from_secs(2)) {
        Err(RecvTimeoutError::Disconnected) => {}
        other => panic!("worker kept running: {other:?}"),
    }
    println!("worker stopped {:?} after drop", t.elapsed());
    drop(ring);

    // Dropping the consumer (ring) also stops it.
    let (tx, rx) = unbounded();
    let cfg = TrackWorkerConfig {
        dst_rate: 48000,
        ring_frames: 256,
        start_ms: 0,
    };
    let (worker, ring) = TrackWorker::spawn(
        "e".into(),
        opener("gapless_full.flac", 0),
        Some("flac".into()),
        cfg,
        tx,
    );
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        WorkerEvent::Ready { .. }
    ));
    drop(ring);
    let t = Instant::now();
    while worker.is_running() {
        assert!(
            t.elapsed() < Duration::from_secs(2),
            "worker ignores an abandoned ring"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

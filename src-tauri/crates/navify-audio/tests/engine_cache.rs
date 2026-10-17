//! Cache controls on the engine handle: size, limit and clear, using a real HTTP stream.

mod source_support;

use std::path::PathBuf;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use navify_audio::api::{EngineCommand, EngineEvent, OutputConfig, TrackSource};
use navify_audio::engine::OutputFactory;
use navify_audio::output::null::{NullOutput, NullPacing};
use navify_audio::output::{OutputError, OutputEvent, OutputRequest, OutputStream};
use navify_audio::source::CacheConfig;
use navify_audio::{AudioEngine, EngineInit};
use source_support::*;

const RATE: u32 = 44_100;

struct NullFactory;

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
        Ok(Box::new(NullOutput::new(ring, RATE, NullPacing::RealTime)))
    }
}

fn play_to_end(engine: &AudioEngine, events: &Receiver<EngineEvent>, id: &str, url: String) {
    engine.send(EngineCommand::Play {
        track: TrackSource {
            id: id.into(),
            location: http_location(url, "srv:t:raw"),
            gain: None,
            duration_hint_ms: None,
            album_key: None,
        },
        start_ms: 0,
        paused: false,
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if let Ok(EngineEvent::TrackEnded { id: ended, .. }) =
            events.recv_timeout(Duration::from_millis(100))
            && ended == id
        {
            return;
        }
    }
    panic!("track {id} never ended");
}

#[test]
fn cache_size_limit_and_clear_work_through_the_engine() {
    let flac = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("decode")
            .join("gapless_full.flac"),
    )
    .unwrap();
    let server = TestServer::start(flac, ServerConfig::default());
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("engine-cache-controls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let engine = AudioEngine::new(EngineInit {
        cache: CacheConfig {
            dir,
            max_bytes: 64 * 1024 * 1024,
        },
        output: Box::new(NullFactory),
    });
    let events = engine.events();
    assert_eq!(engine.cache_size(), 0);

    // Playing to the end leaves a complete entry in the cache.
    play_to_end(&engine, &events, "a", server.url("/t.flac"));
    assert!(
        wait_until(Duration::from_secs(5), || engine.cache_size() > 0),
        "nothing was cached"
    );
    let used = engine.cache_size();

    // A limit below the entry size evicts it once nobody has it open any more.
    engine.set_cache_limit(used / 2);
    assert!(
        wait_until(Duration::from_secs(5), || engine.cache_size() == 0),
        "cache not trimmed: {}",
        engine.cache_size()
    );

    // Fill it again with a roomy limit, then clear explicitly.
    engine.set_cache_limit(64 * 1024 * 1024);
    play_to_end(&engine, &events, "b", server.url("/t.flac"));
    assert!(wait_until(Duration::from_secs(5), || engine.cache_size() > 0));
    assert!(wait_until(Duration::from_secs(5), || {
        engine.clear_cache().unwrap();
        engine.cache_size() == 0
    }));
}

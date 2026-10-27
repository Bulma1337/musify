use std::sync::Arc;
use std::time::{Duration, Instant};

use musify_audio::api::{
    EngineEvent, PlaybackState, SourceLocation, TimeOffsetParam, TimeOffsetUnit, Transition,
};
use parking_lot::Mutex;

use super::*;
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus, TransportState};

#[derive(Debug, Clone, PartialEq)]
enum Call {
    Load { url: String, start_ms: u64, play: bool },
    SetNext(Option<String>),
    Play,
    Pause,
    Stop,
    Seek(u64),
    Volume(f64),
    Close,
}

#[derive(Default)]
struct Device {
    calls: Vec<Call>,
    status: Option<RendererStatus>,
    status_error: Option<fn() -> RendererError>,
    load_error: Option<fn() -> RendererError>,
    set_next_supported: bool,
}

#[derive(Clone, Default)]
struct FakeRenderer(Arc<Mutex<Device>>);

impl Renderer for FakeRenderer {
    fn supported_mimes(&self) -> Vec<String> {
        vec!["audio/flac".into()]
    }
    fn load(&mut self, item: &MediaItem, start_ms: u64, play: bool) -> Result<(), RendererError> {
        let mut d = self.0.lock();
        if let Some(error) = d.load_error {
            return Err(error());
        }
        d.calls.push(Call::Load {
            url: item.url.clone(),
            start_ms,
            play,
        });
        Ok(())
    }
    fn set_next(&mut self, item: Option<&MediaItem>) -> Result<(), RendererError> {
        let mut d = self.0.lock();
        if !d.set_next_supported {
            return Err(RendererError::Unsupported);
        }
        d.calls.push(Call::SetNext(item.map(|i| i.url.clone())));
        Ok(())
    }
    fn play(&mut self) -> Result<(), RendererError> {
        self.0.lock().calls.push(Call::Play);
        Ok(())
    }
    fn pause(&mut self) -> Result<(), RendererError> {
        self.0.lock().calls.push(Call::Pause);
        Ok(())
    }
    fn stop(&mut self) -> Result<(), RendererError> {
        self.0.lock().calls.push(Call::Stop);
        Ok(())
    }
    fn seek(&mut self, position_ms: u64) -> Result<(), RendererError> {
        self.0.lock().calls.push(Call::Seek(position_ms));
        Ok(())
    }
    fn set_volume(&mut self, volume: f64) -> Result<(), RendererError> {
        self.0.lock().calls.push(Call::Volume(volume));
        Ok(())
    }
    fn status(&mut self) -> Result<RendererStatus, RendererError> {
        let d = self.0.lock();
        if let Some(error) = d.status_error {
            return Err(error());
        }
        Ok(d.status.clone().unwrap_or(RendererStatus {
            state: TransportState::Stopped,
            position_ms: None,
            duration_ms: None,
            current_url: None,
            volume: None,
        }))
    }
    fn close(&mut self) {
        self.0.lock().calls.push(Call::Close);
    }
}

/// Publishes tracks under fake proxy URLs (one fresh token per publish) and remembers what is valid.
#[derive(Clone, Default)]
struct FakeHost(Arc<Mutex<HostState>>);

#[derive(Default)]
struct HostState {
    counter: u32,
    published: Vec<(String, u64)>,
    valid: Vec<String>,
}

impl MediaHost for FakeHost {
    fn publish(&mut self, track: &RemoteTrack, offset_ms: u64) -> Result<MediaItem, String> {
        let mut h = self.0.lock();
        h.counter += 1;
        let url = format!("http://192.168.1.2:4000/m/{:032x}.flac", h.counter);
        h.published.push((track.id.clone(), offset_ms));
        h.valid.push(url.clone());
        let seekable = !matches!(track.location, SourceLocation::Http { transcoded: true, .. });
        Ok(MediaItem {
            url,
            mime: track.remote.mime.clone(),
            title: track.remote.title.clone(),
            artist: None,
            album: None,
            cover_url: None,
            duration_ms: track.duration_hint_ms.map(|d| d.saturating_sub(offset_ms)),
            seekable,
        })
    }
    fn retain(&mut self, keep: &[&MediaItem]) {
        self.0.lock().valid.retain(|u| keep.iter().any(|i| &i.url == u));
    }
}

fn track(id: &str, duration_ms: u64) -> RemoteTrack {
    RemoteTrack {
        id: id.into(),
        location: SourceLocation::Http {
            url: format!("https://music.example/rest/stream?id={id}&t=secret"),
            headers: Vec::new(),
            cache_key: format!("srv:{id}"),
            transcoded: false,
            container_hint: Some("flac".into()),
            time_offset: None,
            allow_insecure_tls: false,
        },
        duration_hint_ms: Some(duration_ms),
        remote: RemoteMeta {
            mime: "audio/flac".into(),
            title: format!("Track {id}"),
            artist: None,
            album: None,
            cover: None,
        },
    }
}

fn transcoded(id: &str, duration_ms: u64) -> RemoteTrack {
    let mut t = track(id, duration_ms);
    if let SourceLocation::Http {
        transcoded,
        time_offset,
        ..
    } = &mut t.location
    {
        *transcoded = true;
        *time_offset = Some(TimeOffsetParam {
            param: "timeOffset".into(),
            unit: TimeOffsetUnit::Seconds,
        });
    }
    t
}

struct Harness {
    core: SessionCore,
    device: FakeRenderer,
    host: FakeHost,
    now: Instant,
}

impl Harness {
    fn new() -> Self {
        Self::with(Device::default())
    }

    fn with(device: Device) -> Self {
        let device = FakeRenderer(Arc::new(Mutex::new(device)));
        let host = FakeHost::default();
        Self {
            core: SessionCore::new(Box::new(device.clone()), Box::new(host.clone())),
            device,
            host,
            now: Instant::now(),
        }
    }

    fn send(&mut self, command: RemoteCommand) -> Vec<SessionEvent> {
        self.core.handle(command, self.now);
        self.core.take_events()
    }

    fn play(&mut self, t: RemoteTrack, start_ms: u64) -> Vec<SessionEvent> {
        self.send(RemoteCommand::Play {
            track: t,
            start_ms,
            paused: false,
        })
    }

    /// Lets `ms` pass in ticks, with the device reporting `status`.
    fn run(&mut self, ms: u64, status: Option<RendererStatus>) -> Vec<SessionEvent> {
        self.device.0.lock().status = status;
        let mut events = Vec::new();
        let end = self.now + Duration::from_millis(ms);
        while self.now < end {
            self.now += TICK;
            self.core.tick(self.now);
            events.extend(self.core.take_events());
        }
        events
    }

    fn calls(&self) -> Vec<Call> {
        self.device.0.lock().calls.clone()
    }

    fn url(&self, n: usize) -> String {
        format!("http://192.168.1.2:4000/m/{n:032x}.flac")
    }
}

fn status(state: TransportState, position_ms: u64, url: Option<String>) -> Option<RendererStatus> {
    Some(RendererStatus {
        state,
        position_ms: Some(position_ms),
        duration_ms: None,
        current_url: url,
        volume: None,
    })
}

fn engine(events: &[SessionEvent]) -> Vec<&EngineEvent> {
    events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Engine(e) => Some(e),
            SessionEvent::Ended(_) => None,
        })
        .collect()
}

fn started(events: &[SessionEvent]) -> Vec<(String, Transition)> {
    engine(events)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::TrackStarted { id, transition, .. } => Some((id.clone(), *transition)),
            _ => None,
        })
        .collect()
}

fn ended(events: &[SessionEvent]) -> Vec<(String, bool)> {
    engine(events)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::TrackEnded { id, completed, .. } => Some((id.clone(), *completed)),
            _ => None,
        })
        .collect()
}

fn states(events: &[SessionEvent]) -> Vec<PlaybackState> {
    engine(events)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::StateChanged { state } => Some(*state),
            _ => None,
        })
        .collect()
}

fn last_position(events: &[SessionEvent]) -> Option<u64> {
    engine(events).into_iter().rev().find_map(|e| match e {
        EngineEvent::Position { position_ms, .. } => Some(*position_ms),
        _ => None,
    })
}

#[test]
fn commands_arrive_in_the_engine_json_shape() {
    let json = r#"{"type":"play","startMs":1500,"paused":false,"track":{
        "id":"q1","durationHintMs":200000,"gain":null,"albumKey":"a1",
        "location":{"kind":"http","url":"https://s/rest/stream?id=1","headers":[],"cacheKey":"s:1",
                    "transcoded":false,"containerHint":"flac","timeOffset":null,"allowInsecureTls":false},
        "remote":{"mime":"audio/flac","title":"Song","artist":"Band","album":"Record",
                  "cover":{"url":"https://s/rest/getCoverArt?id=1","headers":[]}}}}"#;
    let command: RemoteCommand = serde_json::from_str(json).unwrap();
    let RemoteCommand::Play { track, start_ms, .. } = command else { panic!() };
    assert_eq!(start_ms, 1500);
    assert_eq!(track.remote.artist.as_deref(), Some("Band"));
    assert!(serde_json::from_str::<RemoteCommand>(r#"{"type":"seek","positionMs":5}"#).is_ok());
    assert!(serde_json::from_str::<RemoteCommand>(r#"{"type":"setNext","track":null}"#).is_ok());
}

#[test]
fn play_loads_the_proxy_url_and_reports_progress() {
    let mut h = Harness::new();
    let events = h.play(track("a", 200_000), 30_000);
    assert_eq!(started(&events), vec![("a".into(), Transition::Manual)]);
    assert_eq!(states(&events), vec![PlaybackState::Playing]);
    assert_eq!(
        h.calls(),
        vec![Call::Load {
            url: h.url(1),
            start_ms: 30_000,
            play: true
        }]
    );

    let events = h.run(2_000, status(TransportState::Playing, 31_000, Some(h.url(1))));
    let position = last_position(&events).unwrap();
    assert!((31_000..=33_500).contains(&position), "position {position}");
    assert!(ended(&events).is_empty());
}

#[test]
fn moves_on_to_the_next_track_when_the_device_stops_at_the_end() {
    let mut h = Harness::new();
    h.play(track("a", 60_000), 0);
    h.run(1_000, status(TransportState::Playing, 40_000, Some(h.url(1))));
    let events = h.run(1_000, status(TransportState::Playing, 57_000, Some(h.url(1))));
    assert!(
        engine(&events)
            .iter()
            .any(|e| matches!(e, EngineEvent::NeedNext { id } if id == "a"))
    );
    h.send(RemoteCommand::SetNext {
        track: Some(track("b", 90_000)),
    });
    h.run(1_000, status(TransportState::Playing, 59_000, Some(h.url(1))));
    // Past the settle time after load, a stop near the end means the track finished.
    let events = h.run(4_000, status(TransportState::Stopped, 0, None));
    assert_eq!(ended(&events), vec![("a".into(), true)]);
    assert_eq!(started(&events), vec![("b".into(), Transition::Gapless)]);
    // url(2) was published for the preload attempt the device refused.
    assert!(h.calls().contains(&Call::Load {
        url: h.url(3),
        start_ms: 0,
        play: true
    }));
    // Only the playing track's URL stays valid.
    assert_eq!(h.host.0.lock().valid, vec![h.url(3)]);
}

#[test]
fn finished_without_next_stops() {
    let mut h = Harness::new();
    h.play(track("a", 60_000), 0);
    h.run(1_000, status(TransportState::Playing, 1_000, Some(h.url(1))));
    let events = h.run(500, status(TransportState::Finished, 0, None));
    assert_eq!(ended(&events), vec![("a".into(), true)]);
    assert_eq!(states(&events), vec![PlaybackState::Stopped]);
    assert!(h.host.0.lock().valid.is_empty());
}

#[test]
fn stopping_on_the_device_mid_track_pauses() {
    let mut h = Harness::new();
    h.play(track("a", 200_000), 0);
    h.run(5_000, status(TransportState::Playing, 60_000, Some(h.url(1))));
    let events = h.run(1_000, status(TransportState::Stopped, 0, None));
    assert_eq!(states(&events), vec![PlaybackState::Paused]);
    assert!(ended(&events).is_empty());
}

#[test]
fn devices_that_preload_go_gapless() {
    let mut h = Harness::with(Device {
        set_next_supported: true,
        ..Device::default()
    });
    h.play(track("a", 60_000), 0);
    h.send(RemoteCommand::SetNext {
        track: Some(track("b", 90_000)),
    });
    assert_eq!(h.calls().last(), Some(&Call::SetNext(Some(h.url(2)))));
    h.run(5_000, status(TransportState::Playing, 58_000, Some(h.url(1))));
    let events = h.run(1_000, status(TransportState::Playing, 500, Some(h.url(2))));
    assert_eq!(ended(&events), vec![("a".into(), true)]);
    assert_eq!(started(&events), vec![("b".into(), Transition::Gapless)]);
    // The device moved on by itself: no second load.
    assert_eq!(h.calls().iter().filter(|c| matches!(c, Call::Load { .. })).count(), 1);
}

#[test]
fn unsupported_preloading_is_not_retried() {
    let mut h = Harness::new();
    h.play(track("a", 60_000), 0);
    h.send(RemoteCommand::SetNext {
        track: Some(track("b", 1)),
    });
    h.device.0.lock().set_next_supported = true;
    h.send(RemoteCommand::SetNext {
        track: Some(track("c", 1)),
    });
    assert!(!h.calls().iter().any(|c| matches!(c, Call::SetNext(_))));
}

#[test]
fn controls_reach_the_device() {
    let mut h = Harness::new();
    h.play(track("a", 200_000), 0);
    assert_eq!(states(&h.send(RemoteCommand::Pause)), vec![PlaybackState::Paused]);
    assert_eq!(states(&h.send(RemoteCommand::Resume)), vec![PlaybackState::Playing]);
    let events = h.send(RemoteCommand::Seek { position_ms: 90_000 });
    assert_eq!(last_position(&events), Some(90_000));
    h.send(RemoteCommand::SetVolume { volume: 1.7 });
    let calls = h.calls();
    assert_eq!(
        &calls[1..],
        &[Call::Pause, Call::Play, Call::Seek(90_000), Call::Volume(1.0)]
    );
    let events = h.send(RemoteCommand::Stop);
    assert_eq!(ended(&events), vec![("a".into(), false)]);
    assert_eq!(states(&events), vec![PlaybackState::Stopped]);
    assert_eq!(h.calls().last(), Some(&Call::Stop));
}

#[test]
fn seeking_a_transcode_restarts_it_at_the_position() {
    let mut h = Harness::new();
    h.play(transcoded("a", 200_000), 0);
    h.send(RemoteCommand::Seek { position_ms: 60_000 });
    assert_eq!(h.host.0.lock().published.last(), Some(&("a".to_string(), 60_000)));
    assert_eq!(
        h.calls().last(),
        Some(&Call::Load {
            url: h.url(2),
            start_ms: 0,
            play: true
        })
    );
    // The device counts from the restart; the player sees the track position.
    let events = h.run(1_000, status(TransportState::Playing, 2_000, Some(h.url(2))));
    let position = last_position(&events).unwrap();
    assert!((62_000..=63_500).contains(&position), "position {position}");
}

#[test]
fn an_unreachable_device_ends_the_session_once() {
    let mut h = Harness::new();
    h.play(track("a", 200_000), 0);
    h.run(2_000, status(TransportState::Playing, 2_000, Some(h.url(1))));
    h.device.0.lock().status_error = Some(|| RendererError::Connection("timed out".into()));
    let events = h.run(8_000, None);
    let ends: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, SessionEvent::Ended(_)))
        .collect();
    assert_eq!(
        ends,
        vec![&SessionEvent::Ended(EndReason::Lost {
            message: "timed out".into()
        })]
    );
    assert_eq!(ended(&events), vec![("a".into(), false)]);
    assert!(h.core.is_ended());
    assert!(h.run(1_000, None).is_empty());
}

#[test]
fn another_controller_takes_over() {
    let mut h = Harness::new();
    h.play(track("a", 200_000), 0);
    h.run(5_000, status(TransportState::Playing, 5_000, Some(h.url(1))));
    let events = h.run(
        4_000,
        status(TransportState::Playing, 1_000, Some("http://other-app/song.mp3".into())),
    );
    assert!(events.contains(&SessionEvent::Ended(EndReason::TakenOver)));
    assert!(!h.calls().contains(&Call::Close));
}

#[test]
fn a_rejected_track_is_reported_and_skipped() {
    let mut h = Harness::with(Device {
        load_error: Some(|| RendererError::Rejected("UPnP error 714".into())),
        ..Device::default()
    });
    let events = h.play(track("a", 1_000), 0);
    assert!(engine(&events).iter().any(|e| matches!(
        e,
        EngineEvent::Error { id: Some(id), .. } if id == "a"
    )));
    assert_eq!(states(&events), vec![PlaybackState::Stopped]);
}

#[test]
fn closing_stops_the_device_and_reports_the_listen() {
    let mut h = Harness::new();
    h.play(track("a", 200_000), 0);
    h.run(10_000, status(TransportState::Playing, 10_000, Some(h.url(1))));
    h.core.close(h.now);
    let events = h.core.take_events();
    let played = engine(&events).iter().find_map(|e| match e {
        EngineEvent::TrackEnded { played_ms, .. } => Some(*played_ms),
        _ => None,
    });
    assert!(played.is_some_and(|p| (8_000..=10_500).contains(&p)), "{played:?}");
    assert_eq!(events.last(), Some(&SessionEvent::Ended(EndReason::Closed)));
    assert_eq!(h.calls().last(), Some(&Call::Close));
    assert!(h.host.0.lock().valid.is_empty());
}

#[test]
fn the_thread_ends_when_the_gate_closes() {
    let gate = Arc::new(NetGate::new());
    gate.set_open(true);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let session = Session::start(
        Box::new(FakeRenderer::default()),
        Box::new(FakeHost::default()),
        gate.clone(),
        Box::new(move |e| sink.lock().push(e)),
    )
    .unwrap();
    session.send(RemoteCommand::Play {
        track: track("a", 200_000),
        start_ms: 0,
        paused: false,
    });
    std::thread::sleep(Duration::from_millis(300));
    gate.set_open(false);
    for _ in 0..40 {
        if session.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(session.is_finished());
    assert!(
        events
            .lock()
            .contains(&SessionEvent::Ended(EndReason::TurnedOff))
    );
}

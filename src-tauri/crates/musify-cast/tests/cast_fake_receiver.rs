//! `CastRenderer` against a fake Cast receiver on localhost (plain TCP, same framing as the real thing).

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use musify_cast::NetGate;
use musify_cast::cast::{CastRenderer, DEFAULT_MEDIA_RECEIVER};
use musify_cast::castv2::{CastChannel, CastMessage, NS_CONNECTION, NS_HEARTBEAT, NS_MEDIA, NS_RECEIVER};
use musify_cast::renderer::{MediaItem, Renderer, RendererError, TransportState};
use serde_json::{Value, json};

const TRANSPORT: &str = "tr-1";
const SESSION: &str = "sess-1";
const MEDIA_SESSION: i64 = 7;
const SECRET_URL: &str = "http://192.168.1.2:4000/t/SECRET/1.flac";

/// What the fake received.
#[derive(Clone, Debug)]
struct Seen {
    namespace: String,
    destination: String,
    source: String,
    json: Value,
}

impl Seen {
    fn kind(&self) -> &str {
        self.json["type"].as_str().unwrap_or("")
    }
}

struct FakeState {
    log: Vec<Seen>,
    launched: bool,
    volume: f64,
    /// The `status` array answered to media `GET_STATUS`.
    media_status: Value,
    /// Answer LOAD with LOAD_FAILED.
    reject_load: bool,
}

struct Fake {
    state: Arc<Mutex<FakeState>>,
    push: Sender<CastMessage>,
    addr: std::net::SocketAddr,
}

fn app() -> Value {
    json!({ "appId": DEFAULT_MEDIA_RECEIVER, "sessionId": SESSION, "transportId": TRANSPORT })
}

impl Fake {
    fn start(already_running: bool) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(FakeState {
            log: Vec::new(),
            launched: already_running,
            volume: 0.5,
            media_status: json!([]),
            reject_load: false,
        }));
        let (push, pushed) = channel();
        let shared = state.clone();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
            serve(CastChannel::new(stream), &shared, pushed);
        });
        Fake { state, push, addr }
    }

    fn client(&self) -> TcpStream {
        let stream = TcpStream::connect(self.addr).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        stream
    }

    fn renderer(&self, gate: &Arc<NetGate>) -> CastRenderer<TcpStream> {
        CastRenderer::over_stream(gate.clone(), self.client()).expect("connect to the fake receiver")
    }

    fn log(&self) -> Vec<Seen> {
        self.state.lock().unwrap().log.clone()
    }

    fn kinds(&self) -> Vec<String> {
        self.log()
            .iter()
            .map(|s| format!("{}>{}", s.kind(), s.destination))
            .collect()
    }

    fn wait_for(&self, what: &str, condition: impl Fn(&[Seen]) -> bool) -> Vec<Seen> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let log = self.log();
            if condition(&log) {
                return log;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; log: {:?}",
                self.kinds()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn set_media_status(&self, status: Value) {
        self.state.lock().unwrap().media_status = status;
    }

    fn send(&self, namespace: &str, source: &str, destination: &str, payload: Value) {
        self.push
            .send(CastMessage {
                source_id: source.into(),
                destination_id: destination.into(),
                namespace: namespace.into(),
                payload: payload.to_string(),
            })
            .unwrap();
    }
}

fn receiver_status(state: &FakeState, request_id: u64) -> Value {
    let applications = if state.launched { json!([app()]) } else { json!([]) };
    json!({
        "type": "RECEIVER_STATUS",
        "requestId": request_id,
        "status": { "applications": applications, "volume": { "level": state.volume, "muted": false } },
    })
}

fn serve(mut channel: CastChannel<TcpStream>, shared: &Mutex<FakeState>, pushed: Receiver<CastMessage>) {
    loop {
        while let Ok(msg) = pushed.try_recv() {
            if channel.send(&msg).is_err() {
                return;
            }
        }
        let msg = match channel.poll() {
            Ok(Some(msg)) => msg,
            Ok(None) => continue,
            Err(_) => return,
        };
        let json: Value = serde_json::from_str(&msg.payload).unwrap();
        let request_id = json["requestId"].as_u64().unwrap_or(0);
        let kind = json["type"].as_str().unwrap_or("").to_string();
        let mut state = shared.lock().unwrap();
        state.log.push(Seen {
            namespace: msg.namespace.clone(),
            destination: msg.destination_id.clone(),
            source: msg.source_id.clone(),
            json: json.clone(),
        });

        let mut replies: Vec<(&str, &str, Value)> = Vec::new();
        match (msg.namespace.as_str(), kind.as_str()) {
            (NS_HEARTBEAT, "PING") => replies.push((NS_HEARTBEAT, "receiver-0", json!({ "type": "PONG" }))),
            (NS_RECEIVER, "GET_STATUS") => {
                replies.push((NS_RECEIVER, "receiver-0", receiver_status(&state, request_id)))
            }
            (NS_RECEIVER, "LAUNCH") => {
                // Like a real device: first a status without the app, then the broadcast with it.
                replies.push((NS_RECEIVER, "receiver-0", receiver_status(&state, request_id)));
                state.launched = true;
                replies.push((NS_RECEIVER, "receiver-0", receiver_status(&state, 0)));
            }
            (NS_RECEIVER, "SET_VOLUME") => {
                state.volume = json["volume"]["level"].as_f64().unwrap();
                replies.push((NS_RECEIVER, "receiver-0", receiver_status(&state, request_id)));
            }
            (NS_MEDIA, "LOAD") if state.reject_load => {
                replies.push((
                    NS_MEDIA,
                    TRANSPORT,
                    json!({ "type": "LOAD_FAILED", "requestId": request_id, "detailedErrorCode": 905 }),
                ));
            }
            (NS_MEDIA, "LOAD") => {
                let player = if json["autoplay"] == true { "PLAYING" } else { "PAUSED" };
                state.media_status =
                    json!([{ "mediaSessionId": MEDIA_SESSION, "playerState": player, "currentTime": 0.0 }]);
                replies.push((
                    NS_MEDIA,
                    TRANSPORT,
                    json!({ "type": "MEDIA_STATUS", "requestId": request_id, "status": state.media_status }),
                ));
            }
            (NS_MEDIA, "GET_STATUS" | "PLAY" | "PAUSE" | "SEEK" | "STOP") => {
                replies.push((
                    NS_MEDIA,
                    TRANSPORT,
                    json!({ "type": "MEDIA_STATUS", "requestId": request_id, "status": state.media_status }),
                ));
            }
            _ => {}
        }
        drop(state);
        for (namespace, source, payload) in replies {
            let reply = CastMessage {
                source_id: source.into(),
                destination_id: msg.source_id.clone(),
                namespace: namespace.into(),
                payload: payload.to_string(),
            };
            if channel.send(&reply).is_err() {
                return;
            }
        }
    }
}

fn open_gate() -> Arc<NetGate> {
    let gate = Arc::new(NetGate::new());
    gate.set_open(true);
    gate
}

fn track() -> MediaItem {
    MediaItem {
        url: SECRET_URL.into(),
        mime: "audio/flac".into(),
        title: "Song".into(),
        artist: Some("Artist".into()),
        album: Some("Album".into()),
        cover_url: Some("http://192.168.1.2:4000/c/SECRET/1.jpg".into()),
        duration_ms: Some(215_500),
        seekable: true,
    }
}

/// Ticks until the renderer reports an error (the fake's message has to arrive first).
fn tick_until_error(renderer: &mut CastRenderer<TcpStream>) -> RendererError {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Err(e) = renderer.tick() {
            return e;
        }
    }
    panic!("tick never failed");
}

#[test]
fn launches_the_receiver_and_connects_in_order() {
    let fake = Fake::start(false);
    let _renderer = fake.renderer(&open_gate());
    let log = fake.wait_for("the transport CONNECT", |log| log.len() >= 4);
    let order: Vec<_> = log
        .iter()
        .map(|s| {
            (
                s.namespace.as_str(),
                s.kind(),
                s.destination.as_str(),
                s.source.as_str(),
            )
        })
        .collect();
    assert_eq!(
        order,
        vec![
            (NS_CONNECTION, "CONNECT", "receiver-0", "sender-0"),
            (NS_RECEIVER, "GET_STATUS", "receiver-0", "sender-0"),
            (NS_RECEIVER, "LAUNCH", "receiver-0", "sender-0"),
            (NS_CONNECTION, "CONNECT", TRANSPORT, "sender-0"),
        ]
    );
    assert_eq!(log[2].json["appId"], DEFAULT_MEDIA_RECEIVER);
    // Request ids increase.
    assert!(log[2].json["requestId"].as_u64() > log[1].json["requestId"].as_u64());
}

#[test]
fn joins_an_app_that_already_runs() {
    let fake = Fake::start(true);
    let _renderer = fake.renderer(&open_gate());
    let log = fake.wait_for("the transport CONNECT", |log| log.len() >= 3);
    assert_eq!(
        fake.kinds(),
        vec!["CONNECT>receiver-0", "GET_STATUS>receiver-0", "CONNECT>tr-1"]
    );
    assert!(log.iter().all(|s| s.kind() != "LAUNCH"));
}

#[test]
fn load_sends_the_media_request() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.load(&track(), 12_250, true).unwrap();

    let load = fake.log().into_iter().find(|s| s.kind() == "LOAD").unwrap();
    assert_eq!(load.namespace, NS_MEDIA);
    assert_eq!(load.destination, TRANSPORT);
    let media = &load.json["media"];
    assert_eq!(media["contentId"], SECRET_URL);
    assert_eq!(media["contentType"], "audio/flac");
    assert_eq!(media["streamType"], "BUFFERED");
    assert_eq!(media["duration"].as_f64(), Some(215.5));
    assert_eq!(media["metadata"]["metadataType"], 3);
    assert_eq!(media["metadata"]["title"], "Song");
    assert_eq!(media["metadata"]["artist"], "Artist");
    assert_eq!(media["metadata"]["albumName"], "Album");
    assert_eq!(
        media["metadata"]["images"][0]["url"],
        "http://192.168.1.2:4000/c/SECRET/1.jpg"
    );
    assert_eq!(load.json["autoplay"], true);
    assert_eq!(load.json["currentTime"].as_f64(), Some(12.25));

    // A silent load: autoplay off.
    renderer.load(&track(), 0, false).unwrap();
    let loads: Vec<_> = fake.log().into_iter().filter(|s| s.kind() == "LOAD").collect();
    assert_eq!(loads[1].json["autoplay"], false);
}

#[test]
fn a_rejected_load_does_not_leak_the_url() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    fake.state.lock().unwrap().reject_load = true;
    let err = renderer.load(&track(), 0, true).unwrap_err();
    match &err {
        RendererError::Rejected(message) => assert_eq!(message, "LOAD_FAILED"),
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert!(!format!("{err} {err:?}").contains("SECRET"));
    assert!(matches!(renderer.pause(), Err(RendererError::Rejected(m)) if m == "nothing loaded"));
}

#[test]
fn transport_controls_use_the_media_session() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    assert!(matches!(renderer.play(), Err(RendererError::Rejected(m)) if m == "nothing loaded"));
    assert!(matches!(renderer.set_next(None), Err(RendererError::Unsupported)));

    renderer.load(&track(), 0, true).unwrap();
    renderer.pause().unwrap();
    renderer.play().unwrap();
    renderer.seek(61_500).unwrap();

    let log = fake.log();
    for kind in ["PAUSE", "PLAY", "SEEK"] {
        let sent = log.iter().find(|s| s.kind() == kind).unwrap();
        assert_eq!(sent.namespace, NS_MEDIA);
        assert_eq!(sent.destination, TRANSPORT);
        assert_eq!(sent.json["mediaSessionId"], MEDIA_SESSION);
    }
    let seek = log.iter().find(|s| s.kind() == "SEEK").unwrap();
    assert_eq!(seek.json["currentTime"].as_f64(), Some(61.5));

    renderer.stop().unwrap();
    assert!(fake.log().iter().any(|s| s.kind() == "STOP" && s.namespace == NS_MEDIA));
    assert!(matches!(renderer.play(), Err(RendererError::Rejected(m)) if m == "nothing loaded"));
}

#[test]
fn volume_is_clamped_and_reported() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.set_volume(0.25).unwrap();
    renderer.set_volume(1.7).unwrap();
    renderer.set_volume(-3.0).unwrap();

    let levels: Vec<_> = fake
        .log()
        .iter()
        .filter(|s| s.kind() == "SET_VOLUME")
        .map(|s| {
            (
                s.namespace.clone(),
                s.destination.clone(),
                s.json["volume"]["level"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        levels,
        vec![
            (NS_RECEIVER.to_string(), "receiver-0".to_string(), 0.25),
            (NS_RECEIVER.to_string(), "receiver-0".to_string(), 1.0),
            (NS_RECEIVER.to_string(), "receiver-0".to_string(), 0.0),
        ]
    );
    renderer.set_volume(0.75).unwrap();
    assert_eq!(renderer.status().unwrap().volume, Some(0.75));
}

#[test]
fn status_maps_player_states() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.load(&track(), 0, true).unwrap();

    fake.set_media_status(json!([{
        "mediaSessionId": MEDIA_SESSION, "playerState": "PLAYING", "currentTime": 42.5, "media": { "duration": 200.0 }
    }]));
    let status = renderer.status().unwrap();
    assert_eq!(status.state, TransportState::Playing);
    assert_eq!(status.position_ms, Some(42_500));
    assert_eq!(status.duration_ms, Some(200_000));
    assert_eq!(status.current_url.as_deref(), Some(SECRET_URL));
    assert_eq!(status.volume, Some(0.5));

    // The status request addresses the media session.
    let request = fake
        .log()
        .into_iter()
        .rev()
        .find(|s| s.kind() == "GET_STATUS" && s.namespace == NS_MEDIA)
        .unwrap();
    assert_eq!(request.json["mediaSessionId"], MEDIA_SESSION);

    let cases = [
        (
            json!({ "playerState": "PAUSED", "currentTime": 1.0 }),
            TransportState::Paused,
        ),
        (json!({ "playerState": "BUFFERING" }), TransportState::Buffering),
        (
            json!({ "playerState": "IDLE", "idleReason": "FINISHED" }),
            TransportState::Finished,
        ),
        (
            json!({ "playerState": "IDLE", "idleReason": "ERROR" }),
            TransportState::Failed,
        ),
        (
            json!({ "playerState": "IDLE", "idleReason": "CANCELLED" }),
            TransportState::Stopped,
        ),
    ];
    for (mut entry, expected) in cases {
        entry["mediaSessionId"] = json!(MEDIA_SESSION);
        fake.set_media_status(json!([entry]));
        let status = renderer.status().unwrap();
        assert_eq!(status.state, expected);
        // The last known duration survives updates that don't carry the media block.
        assert_eq!(status.duration_ms, Some(200_000));
    }

    fake.set_media_status(json!([]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Stopped);
}

#[test]
fn a_finished_broadcast_survives_an_empty_status() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.load(&track(), 0, true).unwrap();

    fake.send(
        NS_MEDIA,
        TRANSPORT,
        "sender-0",
        json!({ "type": "MEDIA_STATUS", "requestId": 0, "status": [
            { "mediaSessionId": MEDIA_SESSION, "playerState": "IDLE", "idleReason": "FINISHED" }
        ] }),
    );
    // The receiver forgets the session once it has ended.
    fake.set_media_status(json!([]));
    std::thread::sleep(Duration::from_millis(100));
    renderer.tick().unwrap();
    assert_eq!(renderer.status().unwrap().state, TransportState::Finished);

    // A new load clears it.
    renderer.load(&track(), 0, true).unwrap();
    fake.set_media_status(json!([]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Stopped);
}

#[test]
fn answers_ping_with_pong() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    fake.send(NS_HEARTBEAT, "receiver-0", "sender-0", json!({ "type": "PING" }));
    // The renderer answers while it ticks (or while it waits for another reply).
    let deadline = Instant::now() + Duration::from_secs(3);
    let pong = loop {
        renderer.tick().unwrap();
        if let Some(pong) = fake.log().into_iter().find(|s| s.kind() == "PONG") {
            break pong;
        }
        assert!(Instant::now() < deadline, "no PONG");
    };
    assert_eq!(pong.namespace, NS_HEARTBEAT);
    assert_eq!(pong.source, "sender-0");
    assert_eq!(pong.destination, "receiver-0");
}

#[test]
fn pings_are_answered_while_waiting_for_a_reply() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    fake.send(NS_HEARTBEAT, "receiver-0", "sender-0", json!({ "type": "PING" }));
    std::thread::sleep(Duration::from_millis(50));
    renderer.set_volume(0.3).unwrap();
    fake.wait_for("PONG", |log| log.iter().any(|s| s.kind() == "PONG"));
}

#[test]
fn a_status_without_our_app_means_taken_over() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.tick().unwrap();
    fake.send(
        NS_RECEIVER,
        "receiver-0",
        "*",
        json!({ "type": "RECEIVER_STATUS", "requestId": 0, "status": {
            "applications": [{ "appId": "OTHER", "sessionId": "other-1", "transportId": "tr-2" }],
            "volume": { "level": 0.5 }
        } }),
    );
    assert!(matches!(tick_until_error(&mut renderer), RendererError::TakenOver));
    // It stays that way, and requests fail without touching the network.
    assert!(matches!(renderer.tick(), Err(RendererError::TakenOver)));
    assert!(matches!(
        renderer.pause(),
        Err(RendererError::TakenOver) | Err(RendererError::Rejected(_))
    ));
    // A taken-over device is not stopped on close: the session now belongs to someone else.
    renderer.close();
    std::thread::sleep(Duration::from_millis(100));
    assert!(fake.log().iter().all(|s| s.kind() != "STOP"));
}

#[test]
fn a_close_from_the_transport_means_taken_over() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    fake.send(NS_CONNECTION, TRANSPORT, "sender-0", json!({ "type": "CLOSE" }));
    assert!(matches!(tick_until_error(&mut renderer), RendererError::TakenOver));
}

#[test]
fn close_stops_the_app_and_closes_the_connections() {
    let fake = Fake::start(false);
    let mut renderer = fake.renderer(&open_gate());
    renderer.load(&track(), 0, true).unwrap();
    renderer.close();

    let log = fake.wait_for("the closing CONNECTION messages", |log| {
        log.iter().filter(|s| s.kind() == "CLOSE").count() == 2
    });
    let tail: Vec<_> = log
        .iter()
        .rev()
        .take(3)
        .rev()
        .map(|s| (s.kind(), s.namespace.as_str(), s.destination.as_str()))
        .collect();
    assert_eq!(
        tail,
        vec![
            ("STOP", NS_RECEIVER, "receiver-0"),
            ("CLOSE", NS_CONNECTION, TRANSPORT),
            ("CLOSE", NS_CONNECTION, "receiver-0"),
        ]
    );
    let stop = log
        .iter()
        .find(|s| s.kind() == "STOP" && s.namespace == NS_RECEIVER)
        .unwrap();
    assert_eq!(stop.json["sessionId"], SESSION);

    // Closing twice is harmless, and the renderer is unusable afterwards.
    renderer.close();
    assert!(matches!(renderer.tick(), Err(RendererError::Connection(_))));
}

#[test]
fn a_closed_gate_makes_tick_fail() {
    let fake = Fake::start(false);
    let gate = open_gate();
    let mut renderer = fake.renderer(&gate);
    renderer.tick().unwrap();
    gate.set_open(false);
    assert!(matches!(renderer.tick(), Err(RendererError::Connection(_))));
    assert!(matches!(renderer.set_volume(0.5), Err(RendererError::Connection(_))));
    // close() must not panic with the gate shut either.
    renderer.close();
}

#[test]
fn a_device_that_hangs_up_is_a_connection_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let _ = listener.accept();
    });
    let stream = TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
    assert!(matches!(
        CastRenderer::over_stream(open_gate(), stream),
        Err(RendererError::Connection(_))
    ));
}

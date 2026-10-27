//! End to end on localhost: a session with the real LAN proxy drives a fake UPnP renderer, which
//! fetches the track from the proxy like a real device would.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use musify_audio::api::{EngineEvent, PlaybackState, SourceLocation};
use musify_cast::connect::connect;
use musify_cast::renderer::{DeviceAddress, DeviceKind, FoundDevice, NetworkDevice, Protocol};
use musify_cast::session::{
    EndReason, MediaHost, RemoteCommand, RemoteMeta, RemoteTrack, Session, SessionEvent,
};
use musify_cast::upnp::{DeviceDescription, ServiceInfo};
use musify_cast::NetGate;

const AV: &str = "urn:schemas-upnp-org:service:AVTransport:1";

#[derive(Default)]
struct Device {
    actions: Vec<String>,
    /// What the device fetched from the URL it was given, and that URL.
    fetched: Option<(String, u16, Vec<u8>)>,
    transport_state: String,
    rel_time: String,
    track_uri: String,
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut data = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]).to_string();
            let length = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            while data.len() < end + 4 + length {
                let n = stream.read(&mut buf).ok()?;
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
            }
            let body = String::from_utf8_lossy(&data[end + 4..]).to_string();
            return Some((head, body));
        }
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
    }
}

fn element<'a>(body: &'a str, name: &str) -> &'a str {
    let open = format!("<{name}>");
    let start = body.find(&open).map(|i| i + open.len()).unwrap_or(0);
    let end = body[start..]
        .find(&format!("</{name}>"))
        .map_or(start, |i| start + i);
    &body[start..end]
}

/// GETs `url` (plain HTTP) the way a renderer starts a stream.
fn fetch(url: &str) -> (u16, Vec<u8>) {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_at(rest.find('/').unwrap());
    let mut stream = TcpStream::connect(host).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes=0-\r\ngetcontentFeatures.dlna.org: 1\r\n\r\n").unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let status = String::from_utf8_lossy(&raw[..end])
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, raw[end + 4..].to_vec())
}

fn reply(action: &str, fields: &[(&str, &str)]) -> String {
    let inner: String = fields
        .iter()
        .map(|(k, v)| format!("<{k}>{v}</{k}>"))
        .collect();
    format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>\
         <u:{action}Response xmlns:u=\"{AV}\">{inner}</u:{action}Response></s:Body></s:Envelope>"
    )
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

fn fake_renderer() -> (SocketAddr, Arc<Mutex<Device>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let device = Arc::new(Mutex::new(Device {
        transport_state: "NO_MEDIA_PRESENT".into(),
        rel_time: "0:00:00".into(),
        ..Device::default()
    }));
    let state = device.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some((head, body)) = read_request(&mut stream) else {
                continue;
            };
            let action = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .starts_with("soapaction")
                        .then(|| l.to_string())
                })
                .and_then(|l| {
                    l.rsplit('#')
                        .next()
                        .map(|a| a.trim_matches('"').to_string())
                })
                .unwrap_or_default();
            let mut d = state.lock().unwrap();
            d.actions.push(action.clone());
            let answer = match action.as_str() {
                "GetProtocolInfo" => reply(
                    &action,
                    &[
                        ("Source", ""),
                        ("Sink", "http-get:*:audio/flac:*,http-get:*:audio/mpeg:*"),
                    ],
                ),
                "SetAVTransportURI" => {
                    let url = unescape(element(&body, "CurrentURI"));
                    let metadata = unescape(element(&body, "CurrentURIMetaData"));
                    assert!(
                        metadata.contains("Rock &amp; Roll"),
                        "DIDL with the title: {metadata}"
                    );
                    let (status, bytes) = fetch(&url);
                    d.fetched = Some((url.clone(), status, bytes));
                    d.track_uri = url;
                    d.transport_state = "STOPPED".into();
                    reply(&action, &[])
                }
                "Play" => {
                    d.transport_state = "PLAYING".into();
                    reply(&action, &[])
                }
                "Stop" => {
                    d.transport_state = "STOPPED".into();
                    reply(&action, &[])
                }
                "GetTransportInfo" => reply(
                    &action,
                    &[
                        ("CurrentTransportState", &d.transport_state),
                        ("CurrentTransportStatus", "OK"),
                    ],
                ),
                "GetPositionInfo" => reply(
                    &action,
                    &[
                        ("Track", "1"),
                        ("TrackDuration", "0:00:10"),
                        ("RelTime", &d.rel_time),
                        ("TrackURI", &d.track_uri),
                    ],
                ),
                "GetVolume" => reply(&action, &[("CurrentVolume", "35")]),
                _ => reply(&action, &[]),
            };
            drop(d);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    (addr, device)
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn plays_a_track_through_the_proxy_and_follows_the_device() {
    let (addr, device) = fake_renderer();
    let control = |path: &str| ServiceInfo {
        service_type: AV.replace("AVTransport", path),
        control_url: format!("http://{addr}/{path}"),
    };
    let found = FoundDevice {
        device: NetworkDevice {
            id: "upnp:uuid:fake".into(),
            name: "Fake".into(),
            protocol: Protocol::Upnp,
            kind: DeviceKind::Speaker,
            model: None,
        },
        address: DeviceAddress::Upnp(Box::new(DeviceDescription {
            udn: "uuid:fake".into(),
            device_type: "urn:schemas-upnp-org:device:MediaRenderer:1".into(),
            friendly_name: "Fake".into(),
            manufacturer: None,
            model_name: None,
            model_description: None,
            av_transport: Some(control("AVTransport")),
            rendering_control: Some(control("RenderingControl")),
            connection_manager: Some(control("ConnectionManager")),
        })),
        ip: addr.ip(),
    };

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secret-folder").join("track.flac");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let audio: Vec<u8> = (0..5000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(&path, &audio).unwrap();

    let gate = Arc::new(NetGate::new());
    gate.set_open(true);
    let connected = connect(&gate, &found).unwrap();
    assert_eq!(connected.info.mimes, vec!["audio/flac", "audio/mpeg"]);
    assert_eq!(connected.info.volume, Some(0.35));
    assert_eq!(connected.renderer.supported_mimes().len(), 2);

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let host: Box<dyn MediaHost> = Box::new(connected.host);
    let session = Session::start(
        connected.renderer,
        host,
        gate.clone(),
        Box::new(move |e| sink.lock().unwrap().push(e)),
    )
    .unwrap();
    session.send(RemoteCommand::Play {
        track: RemoteTrack {
            id: "q1".into(),
            location: SourceLocation::Local { path: path.clone() },
            duration_hint_ms: Some(10_000),
            remote: RemoteMeta {
                mime: "audio/flac".into(),
                title: "Rock & Roll".into(),
                artist: Some("Band".into()),
                album: None,
                cover: None,
            },
        },
        start_ms: 0,
        paused: false,
    });

    wait_for(
        "the device to fetch the track",
        Duration::from_secs(5),
        || device.lock().unwrap().fetched.is_some(),
    );
    let (url, status, bytes) = device.lock().unwrap().fetched.clone().unwrap();
    assert!(url.starts_with("http://127.0.0.1:") && url.contains("/m/") && url.ends_with(".flac"));
    assert!(
        !url.contains("secret-folder"),
        "the URL must not reveal the file: {url}"
    );
    assert_eq!(status, 206);
    assert_eq!(bytes, audio);

    // The device plays to the end and stops by itself.
    device.lock().unwrap().rel_time = "0:00:09".into();
    wait_for("playing", Duration::from_secs(3), || {
        events.lock().unwrap().iter().any(|e| {
            matches!(e, SessionEvent::Engine(EngineEvent::Position { position_ms, .. }) if *position_ms >= 9_000)
        })
    });
    device.lock().unwrap().transport_state = "STOPPED".into();
    wait_for("the end of the track", Duration::from_secs(8), || {
        events.lock().unwrap().iter().any(|e| {
            matches!(e, SessionEvent::Engine(EngineEvent::TrackEnded { id, completed: true, .. }) if id == "q1")
        })
    });
    assert!(
        events
            .lock()
            .unwrap()
            .contains(&SessionEvent::Engine(EngineEvent::StateChanged {
                state: PlaybackState::Stopped
            }))
    );
    // Nothing is published once the queue ran out.
    assert_ne!(fetch(&url).0, 206);

    session.close(Duration::from_secs(3));
    assert!(
        events
            .lock()
            .unwrap()
            .contains(&SessionEvent::Ended(EndReason::Closed))
    );
    assert!(device.lock().unwrap().actions.contains(&"Stop".to_string()));
}

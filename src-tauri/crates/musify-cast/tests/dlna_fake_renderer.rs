//! DLNA control against a fake MediaRenderer on 127.0.0.1: a minimal HTTP/1.1 server that serves the
//! description, answers SOAP actions with canned replies and records every request.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use musify_audio::source::{BlockingClient, build_http_client};
use musify_cast::dlna::DlnaRenderer;
use musify_cast::renderer::{MediaItem, Renderer, RendererError, TransportState};
use musify_cast::upnp::{self, DeviceDescription, ServiceInfo};
use musify_cast::NetGate;

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    path: String,
    soap_action: Option<String>,
    body: String,
}

impl Recorded {
    fn action(&self) -> Option<&str> {
        self.soap_action.as_deref().and_then(|a| a.rsplit('#').next()).map(|a| a.trim_matches('"'))
    }
}

#[derive(Default)]
struct State {
    recorded: Vec<Recorded>,
    /// One-shot replies per action, used before the defaults.
    queued: HashMap<String, VecDeque<(u16, String)>>,
    /// Permanent replies per action.
    fixed: HashMap<String, (u16, String)>,
}

struct FakeRenderer {
    addr: SocketAddr,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
}

const AV: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const RC: &str = "urn:schemas-upnp-org:service:RenderingControl:1";

fn soap_reply(service: &str, action: &str, fields: &[(&str, &str)]) -> (u16, String) {
    let inner: String = fields.iter().map(|(k, v)| format!("<{k}>{v}</{k}>")).collect();
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\
         <u:{action}Response xmlns:u=\"{service}\">{inner}</u:{action}Response></s:Body></s:Envelope>"
    );
    (200, body)
}

fn soap_fault(http_status: u16, code: u32) -> (u16, String) {
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><s:Fault>\
         <faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>\
         <UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{code}</errorCode>\
         <errorDescription>failed</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>"
    );
    (http_status, body)
}

fn default_reply(action: &str) -> (u16, String) {
    match action {
        "GetProtocolInfo" => soap_reply(
            "urn:schemas-upnp-org:service:ConnectionManager:1",
            action,
            &[
                ("Source", ""),
                ("Sink", "http-get:*:audio/mpeg:*,http-get:*:audio/FLAC:*,http-get:*:video/mp4:*"),
            ],
        ),
        "GetTransportInfo" => soap_reply(
            AV,
            action,
            &[("CurrentTransportState", "PLAYING"), ("CurrentTransportStatus", "OK"), ("CurrentSpeed", "1")],
        ),
        "GetPositionInfo" => soap_reply(
            AV,
            action,
            &[
                ("Track", "1"),
                ("TrackDuration", "0:03:05"),
                ("TrackURI", "http://192.168.1.2:4000/s/tok?a=1&amp;b=2"),
                ("RelTime", "0:00:42"),
            ],
        ),
        "GetVolume" => soap_reply(RC, action, &[("CurrentVolume", "30")]),
        "SetAVTransportURI" | "Play" | "Pause" | "Stop" | "Seek" => soap_reply(AV, action, &[]),
        "SetVolume" => soap_reply(RC, action, &[]),
        _ => soap_fault(500, 401),
    }
}

const DESCRIPTION: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
<friendlyName>Fake &amp; Co</friendlyName><manufacturer>Test</manufacturer><modelName>F1</modelName><UDN>uuid:fake-1</UDN>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>
</serviceList></device></root>"#;

impl FakeRenderer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_state, thread_stop) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let state = thread_state.clone();
                std::thread::spawn(move || handle(stream, &state));
            }
        });
        Self { addr, state, stop }
    }

    fn location(&self) -> String {
        format!("http://{}/description.xml", self.addr)
    }

    fn queue(&self, action: &str, reply: (u16, String)) {
        self.state.lock().unwrap().queued.entry(action.to_string()).or_default().push_back(reply);
    }

    fn fix(&self, action: &str, reply: (u16, String)) {
        self.state.lock().unwrap().fixed.insert(action.to_string(), reply);
    }

    fn total_requests(&self) -> usize {
        self.state.lock().unwrap().recorded.len()
    }

    fn actions(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .recorded
            .iter()
            .filter_map(|r| r.action().map(str::to_string))
            .collect()
    }

    fn clear(&self) {
        self.state.lock().unwrap().recorded.clear();
    }

    fn bodies(&self, action: &str) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .recorded
            .iter()
            .filter(|r| r.action() == Some(action))
            .map(|r| r.body.clone())
            .collect()
    }
}

impl Drop for FakeRenderer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn handle(mut stream: TcpStream, state: &Mutex<State>) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split(' ');
    let method = request_line.next().unwrap_or("").to_string();
    let path = request_line.next().unwrap_or("").to_string();
    let mut content_length = 0usize;
    let mut soap_action = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => content_length = value.trim().parse().unwrap_or(0),
                "soapaction" => soap_action = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    while buffer.len() < header_end + content_length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    }
    let body = String::from_utf8_lossy(&buffer[header_end..header_end + content_length]).to_string();
    let recorded = Recorded { method: method.clone(), path: path.clone(), soap_action, body };

    let (status, reply) = {
        let mut state = state.lock().unwrap();
        let reply = if method == "GET" && path == "/description.xml" {
            (200, DESCRIPTION.to_string())
        } else if let Some(action) = recorded.action().map(str::to_string) {
            if let Some(reply) = state.queued.get_mut(&action).and_then(VecDeque::pop_front) {
                reply
            } else if let Some(reply) = state.fixed.get(&action) {
                reply.clone()
            } else {
                default_reply(&action)
            }
        } else {
            (404, String::new())
        };
        state.recorded.push(recorded);
        reply
    };
    let reason = if status == 200 { "OK" } else { "Error" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn client() -> BlockingClient {
    build_http_client(false).unwrap()
}

fn open_gate() -> Arc<NetGate> {
    let gate = Arc::new(NetGate::new());
    gate.set_open(true);
    gate
}

fn item() -> MediaItem {
    MediaItem {
        url: "http://192.168.1.2:4000/s/tok?a=1&b=2".into(),
        mime: "audio/flac".into(),
        title: "Rock & Roll <Live>".into(),
        artist: Some("The Band".into()),
        album: Some("Album".into()),
        cover_url: Some("http://192.168.1.2:4000/c/tok".into()),
        duration_ms: Some(185_000),
        seekable: true,
    }
}

fn connected(fake: &FakeRenderer) -> (DlnaRenderer, Arc<NetGate>, DeviceDescription) {
    let client = client();
    let description = upnp::fetch_description(&client, &fake.location()).unwrap();
    let gate = open_gate();
    let renderer = DlnaRenderer::connect(gate.clone(), client, &description).unwrap();
    fake.clear();
    (renderer, gate, description)
}

#[test]
fn describes_connects_loads_and_reports_status() {
    let fake = FakeRenderer::start();
    let client = client();

    let description = upnp::fetch_description(&client, &fake.location()).unwrap();
    assert_eq!(description.friendly_name, "Fake & Co");
    assert_eq!(description.udn, "uuid:fake-1");
    assert_eq!(description.av_transport.as_ref().unwrap().control_url, format!("http://{}/av", fake.addr));

    let gate = open_gate();
    let mut renderer = DlnaRenderer::connect(gate, client, &description).unwrap();
    assert_eq!(renderer.supported_mimes(), vec!["audio/mpeg", "audio/flac"]);
    assert_eq!(fake.actions(), vec!["GetProtocolInfo"]);
    fake.clear();

    // load at 0:30 with play: URI, Play, wait for PLAYING, Seek.
    renderer.load(&item(), 30_000, true).unwrap();
    assert_eq!(fake.actions(), vec!["SetAVTransportURI", "Play", "GetTransportInfo", "Seek"]);
    let set_uri = &fake.bodies("SetAVTransportURI")[0];
    assert!(set_uri.contains("<CurrentURI>http://192.168.1.2:4000/s/tok?a=1&amp;b=2</CurrentURI>"));
    // DIDL escaped twice: once as XML, once as the SOAP argument.
    assert!(set_uri.contains("&lt;dc:title&gt;Rock &amp;amp; Roll &amp;lt;Live&amp;gt;&lt;/dc:title&gt;"));
    assert!(set_uri.contains("DLNA.ORG_OP=01"));
    assert!(set_uri.contains("<InstanceID>0</InstanceID>"));
    let seek = &fake.bodies("Seek")[0];
    assert!(seek.contains("<Unit>REL_TIME</Unit>") && seek.contains("<Target>0:00:30</Target>"));
    assert!(fake.bodies("Play")[0].contains("<Speed>1</Speed>"));
    {
        let state = fake.state.lock().unwrap();
        let first = &state.recorded[0];
        assert_eq!((first.method.as_str(), first.path.as_str()), ("POST", "/av"));
        assert_eq!(first.soap_action.as_deref(), Some("\"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\""));
    }
    fake.clear();

    // status: transport, position and, on the first call, the volume.
    let status = renderer.status().unwrap();
    assert_eq!(fake.actions(), vec!["GetTransportInfo", "GetPositionInfo", "GetVolume"]);
    assert_eq!(status.state, TransportState::Playing);
    assert_eq!(status.position_ms, Some(42_000));
    assert_eq!(status.duration_ms, Some(185_000));
    assert_eq!(status.current_url.as_deref(), Some("http://192.168.1.2:4000/s/tok?a=1&b=2"));
    assert_eq!(status.volume, Some(0.30));
    fake.clear();
    let status = renderer.status().unwrap();
    assert_eq!(fake.actions(), vec!["GetTransportInfo", "GetPositionInfo"]);
    assert_eq!(status.volume, Some(0.30));
    fake.clear();

    fake.fix("GetTransportInfo", soap_reply(AV, "GetTransportInfo", &[("CurrentTransportState", "PAUSED_PLAYBACK"), ("CurrentTransportStatus", "OK")]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Paused);
    fake.fix("GetTransportInfo", soap_reply(AV, "GetTransportInfo", &[("CurrentTransportState", "TRANSITIONING"), ("CurrentTransportStatus", "OK")]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Buffering);
    fake.fix("GetTransportInfo", soap_reply(AV, "GetTransportInfo", &[("CurrentTransportState", "NO_MEDIA_PRESENT"), ("CurrentTransportStatus", "OK")]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Stopped);
    fake.fix("GetTransportInfo", soap_reply(AV, "GetTransportInfo", &[("CurrentTransportState", "STOPPED"), ("CurrentTransportStatus", "ERROR_OCCURRED")]));
    assert_eq!(renderer.status().unwrap().state, TransportState::Failed);
    fake.fix("GetPositionInfo", soap_reply(AV, "GetPositionInfo", &[("RelTime", "NOT_IMPLEMENTED"), ("TrackDuration", "0:00:00"), ("TrackURI", "")]));
    let status = renderer.status().unwrap();
    assert_eq!((status.position_ms, status.current_url), (None, None));
    fake.clear();

    // set_next: the device doesn't implement it. Remembered, nothing is sent the second time.
    assert!(matches!(renderer.set_next(Some(&item())), Err(RendererError::Unsupported)));
    assert_eq!(fake.actions(), vec!["SetNextAVTransportURI"]);
    assert!(matches!(renderer.set_next(Some(&item())), Err(RendererError::Unsupported)));
    assert!(matches!(renderer.set_next(None), Err(RendererError::Unsupported)));
    assert_eq!(fake.actions(), vec!["SetNextAVTransportURI"]);
    fake.clear();

    renderer.set_volume(0.42).unwrap();
    let body = &fake.bodies("SetVolume")[0];
    assert!(body.contains("<DesiredVolume>42</DesiredVolume>") && body.contains("<Channel>Master</Channel>"));
    renderer.set_volume(1.7).unwrap();
    renderer.set_volume(-0.2).unwrap();
    let volumes = fake.bodies("SetVolume");
    assert!(volumes[1].contains("<DesiredVolume>100</DesiredVolume>"));
    assert!(volumes[2].contains("<DesiredVolume>0</DesiredVolume>"));
    fake.clear();

    renderer.pause().unwrap();
    renderer.seek(125_000).unwrap();
    renderer.stop().unwrap();
    renderer.close();
    assert_eq!(fake.actions(), vec!["Pause", "Seek", "Stop", "Stop"]);
    assert!(fake.bodies("Seek")[0].contains("<Target>0:02:05</Target>"));
}

#[test]
fn set_next_sends_the_item_and_clears_it() {
    let fake = FakeRenderer::start();
    fake.fix("SetNextAVTransportURI", soap_reply(AV, "SetNextAVTransportURI", &[]));
    let (mut renderer, _gate, _) = connected(&fake);

    renderer.set_next(Some(&item())).unwrap();
    let body = &fake.bodies("SetNextAVTransportURI")[0];
    assert!(body.contains("<NextURI>http://192.168.1.2:4000/s/tok?a=1&amp;b=2</NextURI>"));
    assert!(body.contains("&lt;dc:title&gt;Rock &amp;amp; Roll"));

    renderer.set_next(None).unwrap();
    let body = &fake.bodies("SetNextAVTransportURI")[1];
    assert!(body.contains("<NextURI></NextURI>") && body.contains("<NextURIMetaData></NextURIMetaData>"));
}

#[test]
fn busy_device_is_stopped_and_the_load_retried_once() {
    let fake = FakeRenderer::start();
    let (mut renderer, _gate, _) = connected(&fake);

    fake.queue("SetAVTransportURI", soap_fault(500, 701));
    renderer.load(&item(), 0, true).unwrap();
    assert_eq!(fake.actions(), vec!["SetAVTransportURI", "Stop", "SetAVTransportURI", "Play"]);
    fake.clear();

    fake.queue("SetAVTransportURI", soap_fault(500, 705));
    fake.queue("SetAVTransportURI", soap_fault(500, 705));
    let err = renderer.load(&item(), 0, true).unwrap_err();
    assert!(matches!(&err, RendererError::Rejected(m) if m == "UPnP error 705 (SetAVTransportURI)"), "{err:?}");
    assert_eq!(fake.actions(), vec!["SetAVTransportURI", "Stop", "SetAVTransportURI"]);
}

#[test]
fn load_without_play_defers_the_start_position_to_play() {
    let fake = FakeRenderer::start();
    let (mut renderer, _gate, _) = connected(&fake);

    renderer.load(&item(), 30_000, false).unwrap();
    assert_eq!(fake.actions(), vec!["SetAVTransportURI"]);
    fake.clear();

    // The device is still TRANSITIONING once: play waits a poll before it seeks.
    fake.queue("GetTransportInfo", soap_reply(AV, "GetTransportInfo", &[("CurrentTransportState", "TRANSITIONING")]));
    renderer.play().unwrap();
    assert_eq!(fake.actions(), vec!["Play", "GetTransportInfo", "GetTransportInfo", "Seek"]);
    assert!(fake.bodies("Seek")[0].contains("<Target>0:00:30</Target>"));
    fake.clear();

    // The pending position is used up.
    renderer.play().unwrap();
    assert_eq!(fake.actions(), vec!["Play"]);
    fake.clear();

    // A start position under a second needs no seek.
    renderer.load(&item(), 400, true).unwrap();
    assert_eq!(fake.actions(), vec!["SetAVTransportURI", "Play"]);
}

#[test]
fn refused_start_seek_keeps_playing_from_the_start() {
    let fake = FakeRenderer::start();
    let (mut renderer, _gate, _) = connected(&fake);
    fake.fix("Seek", soap_fault(500, 710));
    renderer.load(&item(), 30_000, true).unwrap();
    // An explicit seek reports the refusal.
    assert!(matches!(renderer.seek(5000), Err(RendererError::Rejected(m)) if m == "UPnP error 710 (Seek)"));
}

#[test]
fn faults_and_http_errors_are_mapped() {
    let fake = FakeRenderer::start();
    let (mut renderer, _gate, _) = connected(&fake);

    fake.fix("Pause", soap_fault(500, 701));
    assert!(matches!(renderer.pause(), Err(RendererError::Rejected(m)) if m == "UPnP error 701 (Pause)"));
    fake.fix("Pause", soap_fault(500, 602));
    assert!(matches!(renderer.pause(), Err(RendererError::Unsupported)));
    fake.fix("Stop", (503, "<html>busy</html>".into()));
    assert!(matches!(renderer.stop(), Err(RendererError::Rejected(m)) if m == "HTTP error 503 (Stop)"));
    // A sloppy success without a body still counts as success.
    fake.fix("Stop", (200, String::new()));
    renderer.stop().unwrap();
}

#[test]
fn closed_gate_sends_nothing() {
    let fake = FakeRenderer::start();
    let (mut renderer, gate, description) = connected(&fake);
    gate.set_open(false);

    assert!(matches!(renderer.load(&item(), 0, true), Err(RendererError::Connection(_))));
    assert!(matches!(renderer.status(), Err(RendererError::Connection(_))));
    assert!(matches!(renderer.play(), Err(RendererError::Connection(_))));
    assert!(matches!(renderer.set_next(None), Err(RendererError::Connection(_))));
    assert!(matches!(renderer.set_volume(0.5), Err(RendererError::Connection(_))));
    renderer.close();
    assert_eq!(fake.total_requests(), 0);

    // Connecting while the gate is closed fails before any request, too.
    assert!(matches!(DlnaRenderer::connect(gate.clone(), client(), &description), Err(RendererError::Connection(_))));
    assert_eq!(fake.total_requests(), 0);

    // And it works again once the gate opens.
    gate.set_open(true);
    renderer.pause().unwrap();
    assert_eq!(fake.actions(), vec!["Pause"]);
}

#[test]
fn unreachable_device_is_a_connection_error() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let service = |kind: &str, path: &str| ServiceInfo {
        service_type: format!("urn:schemas-upnp-org:service:{kind}:1"),
        control_url: format!("http://127.0.0.1:{port}/{path}"),
    };
    let description = DeviceDescription {
        udn: "uuid:gone".into(),
        device_type: "urn:schemas-upnp-org:device:MediaRenderer:1".into(),
        friendly_name: "Gone".into(),
        manufacturer: None,
        model_name: None,
        model_description: None,
        av_transport: Some(service("AVTransport", "av")),
        rendering_control: None,
        connection_manager: Some(service("ConnectionManager", "cm")),
    };
    // GetProtocolInfo fails: the list stays empty, the connect itself succeeds.
    let mut renderer = DlnaRenderer::connect(open_gate(), client(), &description).unwrap();
    assert!(renderer.supported_mimes().is_empty());
    let err = renderer.status().unwrap_err();
    assert!(matches!(&err, RendererError::Connection(m) if !m.contains("127.0.0.1")), "{err:?}");
    // No RenderingControl: volume is not supported (and nothing is sent).
    assert!(matches!(renderer.set_volume(0.5), Err(RendererError::Unsupported)));
}

#[test]
fn device_without_av_transport_is_rejected() {
    let fake = FakeRenderer::start();
    let client = client();
    let mut description = upnp::fetch_description(&client, &fake.location()).unwrap();
    description.av_transport = None;
    let result = DlnaRenderer::connect(open_gate(), client, &description);
    assert!(matches!(result, Err(RendererError::Rejected(_))));
    assert_eq!(fake.total_requests(), 1, "only the description was fetched");
}

#[test]
fn description_errors_are_reported() {
    let fake = FakeRenderer::start();
    let client = client();
    let missing = format!("http://{}/missing.xml", fake.addr);
    assert!(matches!(upnp::fetch_description(&client, &missing), Err(upnp::UpnpError::Http(m)) if m == "status 404"));
}

#[test]
fn volume_is_reread_every_fifth_status() {
    let fake = FakeRenderer::start();
    let (mut renderer, _gate, _) = connected(&fake);
    for _ in 0..6 {
        renderer.status().unwrap();
    }
    let volume_reads = fake.actions().iter().filter(|a| *a == "GetVolume").count();
    assert_eq!(volume_reads, 2, "calls 1 and 6");
}

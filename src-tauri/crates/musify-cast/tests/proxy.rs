//! The LAN proxy against a fake server on localhost: ranges, peers, the gate, and that credentials
//! never reach the renderer or the log.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use musify_cast::NetGate;
use musify_cast::proxy::{Proxy, ProxyResource, ProxySource, ResourceKind};

const SECRETS: &[&str] = &["SECRETTOKEN123", "SALT456", "JFKEY789", "alice"];

static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct CaptureLog;

impl log::Log for CaptureLog {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        LOG.lock().unwrap().push(record.args().to_string());
    }
    fn flush(&self) {}
}

fn capture_logs() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        log::set_logger(&CaptureLog).unwrap();
        log::set_max_level(log::LevelFilter::Trace);
    });
}

fn assert_no_secret(text: &str, what: &str) {
    for secret in SECRETS {
        assert!(
            !text.contains(secret),
            "{what} contains a credential: {text}"
        );
    }
}

fn open_gate() -> Arc<NetGate> {
    let gate = Arc::new(NetGate::new());
    gate.set_open(true);
    gate
}

fn localhost() -> std::net::IpAddr {
    "127.0.0.1".parse().unwrap()
}

fn data() -> Vec<u8> {
    (0..1000u32).map(|i| (i % 251) as u8).collect()
}

struct Response {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
}

fn request(url: &str, method: &str, extra: &str) -> Option<Response> {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_at(rest.find('/').unwrap());
    let addr: SocketAddr = host.parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n"
    )
    .ok()?;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let status = head.split(' ').nth(1)?.parse().ok()?;
    Some(Response {
        status,
        head,
        body: raw[end + 4..].to_vec(),
    })
}

fn get(url: &str, extra: &str) -> Response {
    request(url, "GET", extra).expect("response")
}

fn file_resource(path: std::path::PathBuf) -> ProxyResource {
    ProxyResource {
        source: ProxySource::File(path),
        content_type: "audio/flac".into(),
        dlna_features: Some("DLNA.ORG_OP=01".into()),
    }
}

#[test]
fn serves_files_with_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("track.flac");
    std::fs::write(&path, data()).unwrap();
    let proxy = Proxy::start(open_gate(), localhost(), localhost()).unwrap();
    let url = proxy
        .register(ResourceKind::Media, file_resource(path))
        .unwrap();
    assert!(url.ends_with(".flac"));

    let full = get(&url, "");
    assert_eq!(full.status, 200);
    assert_eq!(full.body, data());
    assert_eq!(full.header("content-length").as_deref(), Some("1000"));
    assert_eq!(full.header("accept-ranges").as_deref(), Some("bytes"));

    let part = get(
        &url,
        "Range: bytes=100-199\r\ngetcontentFeatures.dlna.org: 1\r\n",
    );
    assert_eq!(part.status, 206);
    assert_eq!(part.body, &data()[100..200]);
    assert_eq!(
        part.header("content-range").as_deref(),
        Some("bytes 100-199/1000")
    );
    assert_eq!(
        part.header("contentfeatures.dlna.org").as_deref(),
        Some("DLNA.ORG_OP=01")
    );

    let tail = get(&url, "Range: bytes=-10\r\n");
    assert_eq!(tail.body, &data()[990..]);

    let head = request(&url, "HEAD", "").unwrap();
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());

    assert_eq!(get(&url, "Range: bytes=5000-\r\n").status, 416);
    assert_eq!(
        request(&url, "POST", "Content-Length: 0\r\n")
            .unwrap()
            .status,
        405
    );
    let unknown = format!(
        "{}/m/{}.flac",
        url.rsplitn(3, '/').nth(2).unwrap(),
        "0".repeat(32)
    );
    assert_eq!(get(&unknown, "").status, 404);

    proxy.retain(&[]);
    assert!(proxy.is_empty());
    assert_eq!(get(&url, "").status, 404);
}

#[test]
fn other_hosts_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("track.flac");
    std::fs::write(&path, data()).unwrap();
    let renderer = "10.9.8.7".parse().unwrap();
    let proxy = Proxy::start(open_gate(), localhost(), renderer).unwrap();
    let url = proxy
        .register(ResourceKind::Media, file_resource(path))
        .unwrap();
    let response = get(&url, "");
    assert_eq!(response.status, 403);
    assert!(response.body.is_empty());
}

#[test]
fn closed_gate_opens_no_port() {
    let gate = Arc::new(NetGate::new());
    assert!(Proxy::start(gate.clone(), localhost(), localhost()).is_err());
    assert_eq!(gate.sockets_opened(), 0);
}

#[test]
fn turning_off_stops_serving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("track.flac");
    std::fs::write(&path, data()).unwrap();
    let gate = open_gate();
    let proxy = Proxy::start(gate.clone(), localhost(), localhost()).unwrap();
    let url = proxy
        .register(ResourceKind::Media, file_resource(path))
        .unwrap();
    assert_eq!(get(&url, "").status, 200);
    gate.set_open(false);
    assert!(request(&url, "GET", "").is_none_or(|r| r.status != 200));
}

/// A fake music server: records each request head and answers with `data()` (honoring one range),
/// or with a JSON error document for paths containing `gone`.
fn fake_server() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = vec![0u8; 8192];
            let mut head = Vec::new();
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                head.extend_from_slice(&buf[..n]);
            }
            let head = String::from_utf8_lossy(&head).to_string();
            record.lock().unwrap().push(head.clone());
            if head.starts_with("GET /gone") {
                let body = br#"{"subsonic-response":{"status":"failed"}}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
                continue;
            }
            let range = head.lines().find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("range: bytes=")
                    .map(str::to_string)
            });
            let all = data();
            let (status, body, extra) = match range.and_then(|r| {
                let (s, e) = r.split_once('-')?;
                Some((s.parse::<usize>().ok()?, e.parse::<usize>().ok()?))
            }) {
                Some((s, e)) => (
                    "206 Partial Content",
                    all[s..=e].to_vec(),
                    format!("Content-Range: bytes {s}-{e}/{}\r\n", all.len()),
                ),
                None => ("200 OK", all, String::new()),
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: audio/flac\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(&body);
        }
    });
    (base, seen)
}

#[test]
fn forwards_to_the_server_without_leaking_credentials() {
    capture_logs();
    let (base, seen) = fake_server();
    let proxy = Proxy::start(open_gate(), localhost(), localhost()).unwrap();
    let server_url = format!("{base}/rest/stream?id=7&u=alice&t=SECRETTOKEN123&s=SALT456");
    let url = proxy
        .register(
            ResourceKind::Media,
            ProxyResource {
                source: ProxySource::Http {
                    url: server_url,
                    headers: vec![(
                        "Authorization".into(),
                        "MediaBrowser Token=\"JFKEY789\"".into(),
                    )],
                    allow_insecure_tls: false,
                },
                content_type: "audio/flac".into(),
                dlna_features: None,
            },
        )
        .unwrap();
    assert_no_secret(&url, "proxy URL");

    let part = get(&url, "Range: bytes=10-19\r\n");
    assert_eq!(part.status, 206);
    assert_eq!(part.body, &data()[10..20]);
    assert_eq!(
        part.header("content-range").as_deref(),
        Some("bytes 10-19/1000")
    );
    assert_no_secret(&part.head, "response head");

    let full = get(&url, "");
    assert_eq!(full.status, 200);
    assert_eq!(full.body, data());

    let requests = seen.lock().unwrap().clone();
    assert!(
        requests[0].contains("t=SECRETTOKEN123"),
        "the server gets the credentials"
    );
    assert!(requests[0].contains("JFKEY789"));
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("range: bytes=10-19")
    );

    // Error document and an unreachable server: 502, and the log stays free of credentials.
    let gone = proxy
        .register(
            ResourceKind::Media,
            ProxyResource {
                source: ProxySource::Http {
                    url: format!("{base}/gone?t=SECRETTOKEN123"),
                    headers: Vec::new(),
                    allow_insecure_tls: false,
                },
                content_type: "audio/flac".into(),
                dlna_features: None,
            },
        )
        .unwrap();
    assert_eq!(get(&gone, "").status, 502);
    let dead_port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dead = proxy
        .register(
            ResourceKind::Media,
            ProxyResource {
                source: ProxySource::Http {
                    url: format!("http://127.0.0.1:{dead_port}/rest/stream?u=alice&t=SECRETTOKEN123&s=SALT456"),
                    headers: Vec::new(),
                    allow_insecure_tls: false,
                },
                content_type: "audio/flac".into(),
                dlna_features: None,
            },
        )
        .unwrap();
    assert_eq!(get(&dead, "").status, 502);

    let logs = LOG.lock().unwrap().join("\n");
    assert!(
        logs.contains("server request failed"),
        "the failure is logged: {logs}"
    );
    assert_no_secret(&logs, "log");
    for line in LOG.lock().unwrap().iter() {
        assert!(!line.contains("/m/"), "the log names a proxy path: {line}");
    }
}

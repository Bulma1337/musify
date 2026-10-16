//! Shared helpers for the `source_*` integration tests: an in-process HTTP/1.1 test server with
//! configurable range support, throttling, connection drops, missing Content-Length and errors.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, SeekFrom, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use navify_audio::api::{SourceLocation, TimeOffsetParam};
use navify_audio::source::{ByteSource, CacheConfig, SourceEvent, SourceEventSink, SourceManager};

pub fn test_data(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Answer `Range` requests with 206 (otherwise always 200 with the full body).
    pub ranges: bool,
    pub content_length: bool,
    /// Send `burst` bytes, then sleep `pause`.
    pub throttle: Option<(usize, Duration)>,
    /// Close the connection after this many body bytes (per response).
    pub drop_after: Option<u64>,
    /// Answer 500 to the first K requests.
    pub fail_first: usize,
    /// Announce this Content-Length on 200 responses instead of the real one (estimated length).
    pub announce_len: Option<u64>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            ranges: true,
            content_length: true,
            throttle: None,
            drop_after: None,
            fail_first: 0,
            announce_len: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RequestLog {
    pub target: String,
    pub range: Option<String>,
}

pub struct TestServer {
    pub port: u16,
    pub data: Arc<Vec<u8>>,
    requests: Arc<AtomicUsize>,
    log: Arc<Mutex<Vec<RequestLog>>>,
}

impl TestServer {
    pub fn start(data: Vec<u8>, cfg: ServerConfig) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let data = Arc::new(data);
        let requests = Arc::new(AtomicUsize::new(0));
        let log = Arc::new(Mutex::new(Vec::new()));
        {
            let (data, requests, log) = (data.clone(), requests.clone(), log.clone());
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    let (data, requests, log, cfg) =
                        (data.clone(), requests.clone(), log.clone(), cfg.clone());
                    thread::spawn(move || {
                        let _ = handle(stream, &data, &requests, &log, &cfg);
                    });
                }
            });
        }
        Self {
            port,
            data,
            requests,
            log,
        }
    }

    pub fn url(&self, path_and_query: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path_and_query)
    }

    pub fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn log(&self) -> Vec<RequestLog> {
        self.log.lock().unwrap().clone()
    }
}

fn handle(
    mut stream: TcpStream,
    data: &[u8],
    requests: &AtomicUsize,
    log: &Mutex<Vec<RequestLog>>,
    cfg: &ServerConfig,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("").to_owned();
    let mut range = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':')
            && k.trim().eq_ignore_ascii_case("range")
        {
            range = Some(v.trim().to_owned());
        }
    }
    let n = requests.fetch_add(1, Ordering::SeqCst);
    log.lock().unwrap().push(RequestLog {
        target,
        range: range.clone(),
    });
    if n < cfg.fail_first {
        stream.write_all(
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    }

    let len = data.len() as u64;
    let parsed = range
        .as_deref()
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| {
            let (a, b) = r.split_once('-')?;
            let a: u64 = a.parse().ok()?;
            let b: Option<u64> = if b.is_empty() {
                None
            } else {
                Some(b.parse().ok()?)
            };
            Some((a, b))
        });
    let mut head = String::new();
    let (start, end) = match parsed {
        Some((a, b)) if cfg.ranges => {
            if a >= len {
                let msg = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(msg.as_bytes())?;
                return Ok(());
            }
            let end = b.map_or(len, |b| (b + 1).min(len));
            head.push_str("HTTP/1.1 206 Partial Content\r\n");
            head.push_str(&format!("Content-Range: bytes {a}-{}/{len}\r\n", end - 1));
            (a, end)
        }
        _ => {
            head.push_str("HTTP/1.1 200 OK\r\n");
            (0, len)
        }
    };
    if cfg.ranges {
        head.push_str("Accept-Ranges: bytes\r\n");
    }
    if cfg.content_length {
        let announced = if start == 0 && end == len {
            cfg.announce_len.unwrap_or(len)
        } else {
            end - start
        };
        head.push_str(&format!("Content-Length: {announced}\r\n"));
    }
    head.push_str("Content-Type: application/octet-stream\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;

    let limit = cfg.drop_after.map_or(end, |d| (start + d).min(end));
    let burst = cfg.throttle.map_or(64 * 1024, |t| t.0);
    let mut pos = start;
    while pos < limit {
        let next = (pos + burst as u64).min(limit);
        stream.write_all(&data[pos as usize..next as usize])?;
        pos = next;
        if let Some((_, pause)) = cfg.throttle {
            thread::sleep(pause);
        }
    }
    stream.flush()?;
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

pub struct Events(pub Arc<Mutex<Vec<SourceEvent>>>);

impl Events {
    pub fn new() -> (Self, SourceEventSink) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s = store.clone();
        let sink: SourceEventSink = Arc::new(move |e| s.lock().unwrap().push(e));
        (Events(store), sink)
    }

    pub fn all(&self) -> Vec<SourceEvent> {
        self.0.lock().unwrap().clone()
    }

    pub fn completed(&self, key: &str) -> bool {
        self.all()
            .iter()
            .any(|e| matches!(e, SourceEvent::Completed { cache_key, .. } if cache_key == key))
    }

    pub fn wait_completed(&self, key: &str) {
        assert!(
            wait_until(Duration::from_secs(20), || self.completed(key)),
            "entry {key} never completed"
        );
    }
}

pub fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    cond()
}

pub fn manager(dir: &Path, max_bytes: u64) -> (SourceManager, Events) {
    let (events, sink) = Events::new();
    let mgr = SourceManager::new(
        CacheConfig {
            dir: dir.to_path_buf(),
            max_bytes,
        },
        sink,
    );
    (mgr, events)
}

pub fn http_location(url: String, key: &str) -> SourceLocation {
    SourceLocation::Http {
        url,
        headers: vec![("X-Test".into(), "1".into())],
        cache_key: key.into(),
        transcoded: false,
        container_hint: None,
        time_offset: None,
        allow_insecure_tls: false,
    }
}

pub fn transcoded_location(
    url: String,
    key: &str,
    time_offset: Option<TimeOffsetParam>,
) -> SourceLocation {
    SourceLocation::Http {
        url,
        headers: vec![],
        cache_key: key.into(),
        transcoded: true,
        container_hint: Some("mp3".into()),
        time_offset,
        allow_insecure_tls: false,
    }
}

/// Reads until `buf` is full or EOF; returns the number of bytes read.
pub fn read_full(src: &mut dyn ByteSource, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = src.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

pub fn read_all(src: &mut dyn ByteSource) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 50_000];
    loop {
        let n = src.read(&mut buf).expect("read");
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    out
}

pub fn seek(src: &mut dyn ByteSource, pos: SeekFrom) -> std::io::Result<u64> {
    src.seek(pos)
}

pub fn hash_hex(key: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn dir_names(dir: &Path) -> Vec<String> {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Seeks to `pos` and reads up to `len` bytes.
pub fn read_exact_at(src: &mut dyn ByteSource, pos: u64, len: usize) -> Vec<u8> {
    src.seek(SeekFrom::Start(pos)).expect("seek");
    let mut buf = vec![0u8; len];
    let n = read_full(src, &mut buf).expect("read");
    buf.truncate(n);
    buf
}

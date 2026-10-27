//! The LAN proxy renderers fetch tracks and covers from.
//!
//! Renderers get `http://<lan-ip>:<port>/m/<token>.<ext>` instead of the server's stream URL, which
//! carries the user's credentials (Subsonic token and salt, Jellyfin API key). Each URL holds a random
//! 128-bit token that stays valid only while the session needs it (current and next track), and only
//! the renderer's IP address may fetch. Requests are forwarded to the server with their `Range`
//! header (downloaded files are read directly). URLs, tokens and request paths are never logged.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use musify_audio::source::{BlockingClient, build_http_client, describe_reqwest, is_document_type};
use parking_lot::Mutex;

use crate::gate::NetGate;

/// Longest request head accepted.
const MAX_HEAD: usize = 16 * 1024;
/// Renderers open one or two connections at a time; anything beyond this is refused.
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxySource {
    /// A server URL; may contain credentials, and so may the headers.
    Http {
        url: String,
        headers: Vec<(String, String)>,
        allow_insecure_tls: bool,
    },
    /// A downloaded file.
    File(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyResource {
    pub source: ProxySource,
    /// Sent for files, and for server responses without an audio or image type.
    pub content_type: String,
    /// `contentFeatures.dlna.org` for renderers that ask for it.
    pub dlna_features: Option<String>,
}

/// Which path a resource is served under (`/m/` media, `/c/` covers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceKind {
    Media,
    Cover,
}

struct Shared {
    entries: Mutex<HashMap<String, Arc<ProxyResource>>>,
    allowed_peer: IpAddr,
    stop: AtomicBool,
    gate: Arc<NetGate>,
    generation: u64,
    connections: AtomicUsize,
    /// Blocking clients, verifying (`[0]`) and accepting any certificate (`[1]`), built on first use.
    clients: Mutex<[Option<BlockingClient>; 2]>,
}

impl Shared {
    /// Stopped by the session, or network speakers were turned off meanwhile.
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
            || !self.gate.is_open()
            || self.gate.generation() != self.generation
    }

    fn client(&self, insecure: bool) -> Result<BlockingClient, String> {
        let mut clients = self.clients.lock();
        let slot = &mut clients[usize::from(insecure)];
        if let Some(client) = slot {
            return Ok(client.clone());
        }
        let client = build_http_client(insecure).map_err(|e| e.to_string())?;
        *slot = Some(client.clone());
        Ok(client)
    }
}

pub struct Proxy {
    shared: Arc<Shared>,
    addr: SocketAddr,
    accept: Option<JoinHandle<()>>,
}

impl Proxy {
    /// Listens on `bind_ip` (the interface that reaches the renderer) at a free port. Only
    /// `allowed_peer` may fetch.
    pub fn start(gate: Arc<NetGate>, bind_ip: IpAddr, allowed_peer: IpAddr) -> io::Result<Proxy> {
        let generation = gate.generation();
        let listener = gate.tcp_listener(SocketAddr::new(bind_ip, 0))?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            entries: Mutex::new(HashMap::new()),
            allowed_peer: allowed_peer.to_canonical(),
            stop: AtomicBool::new(false),
            gate,
            generation,
            connections: AtomicUsize::new(0),
            clients: Mutex::new([None, None]),
        });
        let accept_shared = shared.clone();
        let accept = std::thread::Builder::new()
            .name("musify-cast-proxy".into())
            .spawn(move || accept_loop(listener, accept_shared))?;
        Ok(Proxy {
            shared,
            addr,
            accept: Some(accept),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Makes `resource` available and returns its URL (with a fresh secret token).
    pub fn register(&self, kind: ResourceKind, resource: ProxyResource) -> io::Result<String> {
        let token = new_token()?;
        let prefix = match kind {
            ResourceKind::Media => "m",
            ResourceKind::Cover => "c",
        };
        let url = format!(
            "http://{}/{prefix}/{token}{}",
            self.addr,
            extension_for(&resource.content_type)
        );
        self.shared.entries.lock().insert(token, Arc::new(resource));
        Ok(url)
    }

    /// Revokes every URL except `keep` (URLs returned by [`Proxy::register`]).
    pub fn retain(&self, keep: &[&str]) {
        let keep: Vec<&str> = keep.iter().filter_map(|url| token_of_url(url)).collect();
        self.shared
            .entries
            .lock()
            .retain(|token, _| keep.contains(&token.as_str()));
    }

    /// Number of URLs currently valid.
    pub fn len(&self) -> usize {
        self.shared.entries.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.entries.lock().clear();
        // Wake the blocking accept so the thread sees the stop flag.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(500));
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// File extension for a MIME type; some renderers pick the decoder by the URL's extension.
pub fn extension_for(mime: &str) -> &'static str {
    match mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/flac" | "audio/x-flac" => ".flac",
        "audio/mpeg" | "audio/mp3" => ".mp3",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => ".m4a",
        "audio/aac" | "audio/aacp" => ".aac",
        "audio/ogg" | "audio/opus" => ".ogg",
        "audio/webm" => ".webm",
        "audio/wav" | "audio/x-wav" | "audio/wave" => ".wav",
        "audio/aiff" | "audio/x-aiff" => ".aiff",
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        _ => "",
    }
}

/// The token in a proxy URL or request path (`…/m/<token>.flac` → `<token>`).
pub(crate) fn token_of_url(url: &str) -> Option<&str> {
    let last = url.rsplit('/').next()?;
    let token = last.split('.').next()?;
    (token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

/// `/m/<token>[.ext]` or `/c/<token>[.ext]`.
fn parse_path(path: &str) -> Option<(ResourceKind, &str)> {
    let path = path.split(['?', '#']).next()?;
    let rest = path.strip_prefix('/')?;
    let (prefix, name) = rest.split_once('/')?;
    let kind = match prefix {
        "m" => ResourceKind::Media,
        "c" => ResourceKind::Cover,
        _ => return None,
    };
    if name.contains('/') {
        return None;
    }
    Some((kind, token_of_url(name)?))
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    method: String,
    path: String,
    http11: bool,
    headers: Vec<(String, String)>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn parse_request(head: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let version = parts.next()?;
    if parts.next().is_some() || !path.starts_with('/') || !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Some(Request {
        method,
        path,
        http11: version == "HTTP/1.1",
        headers,
    })
}

/// Reads up to the end of the request head (`\r\n\r\n`).
fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            head.truncate(end + 4);
            return Ok(head);
        }
        if head.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ByteRange {
    Full,
    /// Inclusive.
    Partial(u64, u64),
    Unsatisfiable,
}

/// A single `bytes=` range against a resource of `len` bytes. Multiple or malformed ranges are
/// answered with the whole resource, as RFC 9110 allows.
fn parse_range(value: Option<&str>, len: u64) -> ByteRange {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return ByteRange::Full;
    };
    if spec.contains(',') {
        return ByteRange::Full;
    }
    let Some((start, end)) = spec.trim().split_once('-') else {
        return ByteRange::Full;
    };
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() {
        // Suffix range: the last `n` bytes.
        let Ok(n) = end.parse::<u64>() else {
            return ByteRange::Full;
        };
        if n == 0 || len == 0 {
            return ByteRange::Unsatisfiable;
        }
        return ByteRange::Partial(len.saturating_sub(n), len - 1);
    }
    let Ok(start) = start.parse::<u64>() else {
        return ByteRange::Full;
    };
    let end = if end.is_empty() {
        len.saturating_sub(1)
    } else {
        match end.parse::<u64>() {
            Ok(e) if e >= start => e.min(len.saturating_sub(1)),
            _ => return ByteRange::Full,
        }
    };
    if start >= len {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Partial(start, end)
}

/// The `Range` value forwarded to the server: only a single well-formed byte range.
fn forwardable_range(value: Option<&str>) -> Option<String> {
    let spec = value?.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let ok = !spec.contains(',')
        && (start.is_empty() || start.bytes().all(|b| b.is_ascii_digit()))
        && end.bytes().all(|b| b.is_ascii_digit())
        && !(start.is_empty() && end.is_empty());
    ok.then(|| format!("bytes={start}-{end}"))
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

fn respond_status(stream: &mut TcpStream, status: u16) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        status_text(status)
    )?;
    stream.flush()
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stopped() {
            break;
        }
        let Ok(stream) = stream else { continue };
        if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let conn_shared = shared.clone();
        let spawned = std::thread::Builder::new()
            .name("musify-cast-proxy-conn".into())
            .spawn(move || {
                if let Err(e) = handle(stream, &conn_shared) {
                    log::debug!("network speakers: proxy connection ended: {}", e.kind());
                }
                conn_shared.connections.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn handle(mut stream: TcpStream, shared: &Shared) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    // Other hosts are turned away before their request is even read.
    if stream.peer_addr()?.ip().to_canonical() != shared.allowed_peer {
        log::warn!("network speakers: refused a proxy request from another address");
        return respond_status(&mut stream, 403);
    }
    let head = read_head(&mut stream)?;
    if shared.stopped() {
        return respond_status(&mut stream, 503);
    }
    let Some(request) = parse_request(&head) else {
        return respond_status(&mut stream, 400);
    };
    let head_only = match request.method.as_str() {
        "GET" => false,
        "HEAD" => true,
        _ => return respond_status(&mut stream, 405),
    };
    let resource =
        parse_path(&request.path).and_then(|(_, token)| shared.entries.lock().get(token).cloned());
    let Some(resource) = resource else {
        return respond_status(&mut stream, 404);
    };
    match &resource.source {
        ProxySource::File(path) => {
            serve_file(&mut stream, &request, &resource, path, head_only, shared)
        }
        ProxySource::Http {
            url,
            headers,
            allow_insecure_tls,
        } => serve_http(
            &mut stream,
            &request,
            &resource,
            (url, headers, *allow_insecure_tls),
            head_only,
            shared,
        ),
    }
}

/// Response headers both sources share (DLNA extras when asked for).
fn common_headers(request: &Request, resource: &ProxyResource) -> String {
    let mut out = String::new();
    if let Some(features) = &resource.dlna_features {
        if request.header("getcontentFeatures.dlna.org").is_some() {
            out.push_str(&format!("contentFeatures.dlna.org: {features}\r\n"));
        }
        out.push_str("transferMode.dlna.org: Streaming\r\n");
    }
    out.push_str("Connection: close\r\n");
    out
}

fn serve_file(
    stream: &mut TcpStream,
    request: &Request,
    resource: &ProxyResource,
    path: &std::path::Path,
    head_only: bool,
    shared: &Shared,
) -> io::Result<()> {
    let Ok(mut file) = File::open(path) else {
        log::warn!("network speakers: a downloaded track could not be opened");
        return respond_status(stream, 404);
    };
    let len = file.metadata()?.len();
    let (status, start, count) = match parse_range(request.header("range"), len) {
        ByteRange::Full => (200, 0, len),
        ByteRange::Partial(start, end) => (206, start, end - start + 1),
        ByteRange::Unsatisfiable => {
            write!(
                stream,
                "HTTP/1.1 416 {}\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                status_text(416)
            )?;
            return stream.flush();
        }
    };
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\n",
        status_text(status),
        resource.content_type
    );
    if status == 206 {
        head.push_str(&format!(
            "Content-Range: bytes {start}-{}/{len}\r\n",
            start + count - 1
        ));
    }
    head.push_str(&common_headers(request, resource));
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if head_only {
        return stream.flush();
    }
    file.seek(SeekFrom::Start(start))?;
    pump(&mut file.take(count), stream, false, shared)
}

fn serve_http(
    stream: &mut TcpStream,
    request: &Request,
    resource: &ProxyResource,
    (url, headers, insecure): (&str, &[(String, String)], bool),
    head_only: bool,
    shared: &Shared,
) -> io::Result<()> {
    let client = match shared.client(insecure) {
        Ok(client) => client,
        Err(e) => {
            log::warn!("network speakers: HTTP client setup failed: {e}");
            return respond_status(stream, 502);
        }
    };
    let mut upstream = if head_only {
        client.head(url)
    } else {
        client.get(url)
    };
    for (name, value) in headers {
        upstream = upstream.header(name.as_str(), value.as_str());
    }
    if let Some(range) = forwardable_range(request.header("range")) {
        upstream = upstream.header("Range", range);
    }
    let mut response = match upstream.send() {
        Ok(response) => response,
        Err(e) => {
            log::warn!(
                "network speakers: server request failed: {}",
                describe_reqwest(e, url)
            );
            return respond_status(stream, 502);
        }
    };
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    if status == 416 {
        let mut head = format!("HTTP/1.1 416 {}\r\n", status_text(416));
        if let Some(range) = header("content-range") {
            head.push_str(&format!("Content-Range: {range}\r\n"));
        }
        head.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
        stream.write_all(head.as_bytes())?;
        return stream.flush();
    }
    if status != 200 && status != 206 {
        log::warn!("network speakers: the server answered HTTP {status}");
        return respond_status(stream, 502);
    }
    let upstream_type = header("content-type");
    // Subsonic servers report errors (e.g. a track that is gone) as a 200 JSON/XML document.
    if upstream_type.as_deref().is_some_and(is_document_type) {
        log::warn!("network speakers: the server sent an error document instead of audio");
        return respond_status(stream, 502);
    }
    let content_type = upstream_type
        .filter(|t| t.starts_with("audio/") || t.starts_with("image/"))
        .unwrap_or_else(|| resource.content_type.clone());
    let length = header("content-length").and_then(|v| v.parse::<u64>().ok());
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\n",
        status_text(status)
    );
    if let Some(length) = length {
        head.push_str(&format!("Content-Length: {length}\r\n"));
    }
    if let Some(range) = header("content-range") {
        head.push_str(&format!("Content-Range: {range}\r\n"));
    }
    match header("accept-ranges") {
        Some(ranges) => head.push_str(&format!("Accept-Ranges: {ranges}\r\n")),
        None if status == 206 => head.push_str("Accept-Ranges: bytes\r\n"),
        None => {}
    }
    let chunked = length.is_none() && request.http11 && !head_only;
    if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
    }
    head.push_str(&common_headers(request, resource));
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if head_only {
        return stream.flush();
    }
    pump(&mut response, stream, chunked, shared)
}

/// Copies the body, stopping as soon as the proxy stops (session ended, network speakers off).
fn pump(
    from: &mut impl Read,
    to: &mut TcpStream,
    chunked: bool,
    shared: &Shared,
) -> io::Result<()> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        if shared.stopped() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunked {
            write!(to, "{n:x}\r\n")?;
            to.write_all(&buf[..n])?;
            to.write_all(b"\r\n")?;
        } else {
            to.write_all(&buf[..n])?;
        }
    }
    if chunked {
        to.write_all(b"0\r\n\r\n")?;
    }
    to.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn paths_carry_only_valid_tokens() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_path(&format!("/m/{token}.flac")),
            Some((ResourceKind::Media, token))
        );
        assert_eq!(
            parse_path(&format!("/c/{token}")),
            Some((ResourceKind::Cover, token))
        );
        assert_eq!(
            parse_path(&format!("/m/{token}.mp3?x=1")),
            Some((ResourceKind::Media, token))
        );
        assert_eq!(parse_path(&format!("/x/{token}")), None);
        assert_eq!(parse_path("/m/short"), None);
        assert_eq!(parse_path(&format!("/m/../{token}")), None);
        assert_eq!(parse_path(&format!("/m/{}g", &token[..31])), None);
    }

    #[test]
    fn request_head_parsing() {
        let r =
            parse_request(b"GET /m/abc HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n").unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/m/abc");
        assert!(r.http11);
        assert_eq!(r.header("range"), Some("bytes=0-"));
        assert!(parse_request(b"GET http://evil/ HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_request(b"GARBAGE\r\n\r\n").is_none());
        assert!(!parse_request(b"HEAD / HTTP/1.0\r\n\r\n").unwrap().http11);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), ByteRange::Full);
        assert_eq!(
            parse_range(Some("bytes=0-"), 100),
            ByteRange::Partial(0, 99)
        );
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100),
            ByteRange::Partial(10, 19)
        );
        assert_eq!(
            parse_range(Some("bytes=90-200"), 100),
            ByteRange::Partial(90, 99)
        );
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            ByteRange::Partial(90, 99)
        );
        assert_eq!(
            parse_range(Some("bytes=-500"), 100),
            ByteRange::Partial(0, 99)
        );
        assert_eq!(
            parse_range(Some("bytes=100-"), 100),
            ByteRange::Unsatisfiable
        );
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), ByteRange::Full);
        assert_eq!(parse_range(Some("bytes=5-2"), 100), ByteRange::Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), ByteRange::Full);
    }

    #[test]
    fn only_simple_ranges_are_forwarded() {
        assert_eq!(forwardable_range(Some("bytes=0-")), Some("bytes=0-".into()));
        assert_eq!(
            forwardable_range(Some("bytes=-500")),
            Some("bytes=-500".into())
        );
        assert_eq!(forwardable_range(Some("bytes=1-2,4-5")), None);
        assert_eq!(forwardable_range(Some("bytes=a-b")), None);
        assert_eq!(forwardable_range(Some("bytes=-")), None);
        assert_eq!(forwardable_range(Some("bytes=0-\r\nX-Evil: 1")), None);
    }

    #[test]
    fn extensions() {
        assert_eq!(extension_for("audio/flac"), ".flac");
        assert_eq!(extension_for("audio/mpeg"), ".mp3");
        assert_eq!(extension_for("Audio/MP4; codecs=alac"), ".m4a");
        assert_eq!(extension_for("application/octet-stream"), "");
    }
}

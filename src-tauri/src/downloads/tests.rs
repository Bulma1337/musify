//! Manager and transfer tests against a tiny HTTP server running inside the test process.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::manager::{
    CoverJob, DownloadUpdate, EnqueueJob, Manager, PARALLEL, RetryPolicy, files_below,
};
use super::paths::{self, PARTIAL_DIR, TrackLayout};
use super::store::{self, CollectionInput, TrackKey};
use super::transfer::{self, Source, TransferError};
use crate::db::Db;

// --- Test server ---------------------------------------------------------------------------------

#[derive(Clone)]
struct Behavior {
    /// Answer `Range` requests with 206 (otherwise always 200 with the full body).
    ranges: bool,
    /// Answer 500 to the first N requests of any path.
    fail_first: usize,
    /// Sleep this long after each 16 KiB of body.
    chunk_delay: Duration,
    /// The first response sends this many body bytes and then closes the connection.
    cut_first_after: Option<usize>,
    /// Fixed status for these paths.
    status: HashMap<String, u16>,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            ranges: true,
            fail_first: 0,
            chunk_delay: Duration::ZERO,
            cut_first_after: None,
            status: HashMap::new(),
        }
    }
}

struct ServerState {
    files: Mutex<HashMap<String, Vec<u8>>>,
    behavior: Mutex<Behavior>,
    requests: Mutex<Vec<(String, Option<String>)>>,
    served: AtomicUsize,
    concurrent: AtomicUsize,
    max_concurrent: AtomicUsize,
    stop: AtomicBool,
}

struct TestServer {
    addr: std::net::SocketAddr,
    state: Arc<ServerState>,
}

impl TestServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(ServerState {
            files: Mutex::new(HashMap::new()),
            behavior: Mutex::new(Behavior::default()),
            requests: Mutex::new(Vec::new()),
            served: AtomicUsize::new(0),
            concurrent: AtomicUsize::new(0),
            max_concurrent: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
        });
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            while !shared.stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let shared = Arc::clone(&shared);
                        thread::spawn(move || handle(stream, &shared));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self { addr, state }
    }

    fn put(&self, path: &str, data: Vec<u8>) {
        self.state.files.lock().unwrap().insert(path.into(), data);
    }

    fn behave(&self, f: impl FnOnce(&mut Behavior)) {
        f(&mut self.state.behavior.lock().unwrap());
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn requests_for(&self, path: &str) -> Vec<Option<String>> {
        self.state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p == path)
            .map(|(_, r)| r.clone())
            .collect()
    }

    fn max_concurrent(&self) -> usize {
        self.state.max_concurrent.load(Ordering::SeqCst)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.state.stop.store(true, Ordering::Relaxed);
    }
}

fn handle(mut stream: TcpStream, state: &ServerState) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_lowercase().strip_prefix("range:") {
            range = Some(value.trim().to_string());
        }
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
    let serial = state.served.fetch_add(1, Ordering::SeqCst);
    state
        .requests
        .lock()
        .unwrap()
        .push((path.clone(), range.clone()));

    let now = state.concurrent.fetch_add(1, Ordering::SeqCst) + 1;
    state.max_concurrent.fetch_max(now, Ordering::SeqCst);
    respond(&mut stream, state, &path, range.as_deref(), serial);
    state.concurrent.fetch_sub(1, Ordering::SeqCst);
    let _ = stream.shutdown(Shutdown::Both);
}

fn respond(
    stream: &mut TcpStream,
    state: &ServerState,
    path: &str,
    range: Option<&str>,
    serial: usize,
) {
    let behavior = state.behavior.lock().unwrap().clone();
    let simple = |stream: &mut TcpStream, code: u16, text: &str| {
        let _ = write!(
            stream,
            "HTTP/1.1 {code} {text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    };
    if serial < behavior.fail_first {
        return simple(stream, 500, "Internal Server Error");
    }
    if let Some(code) = behavior.status.get(path) {
        return simple(stream, *code, "Error");
    }
    let Some(data) = state.files.lock().unwrap().get(path).cloned() else {
        return simple(stream, 404, "Not Found");
    };
    let total = data.len();
    let start = range
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| r.strip_suffix('-'))
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|_| behavior.ranges);
    let (head, body): (String, &[u8]) = match start {
        Some(start) if start >= total => {
            return {
                let _ = write!(
                    stream,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            };
        }
        Some(start) => (
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/flac\r\nContent-Range: bytes {start}-{}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                total - 1,
                total - start
            ),
            &data[start..],
        ),
        None => (
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: audio/flac\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
            ),
            &data[..],
        ),
    };
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let limit = if serial == 0 {
        behavior.cut_first_after
    } else {
        None
    };
    let mut sent = 0;
    let chunks = body.chunks(16 * 1024).count();
    for (index, chunk) in body.chunks(16 * 1024).enumerate() {
        let chunk = match limit {
            Some(max) if sent + chunk.len() > max => &chunk[..max.saturating_sub(sent)],
            _ => chunk,
        };
        if stream.write_all(chunk).is_err() {
            return;
        }
        sent += chunk.len();
        if limit.is_some_and(|max| sent >= max) {
            return;
        }
        if !behavior.chunk_delay.is_zero() && index + 1 < chunks {
            thread::sleep(behavior.chunk_delay);
        }
    }
}

fn data(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

// --- Fixtures ------------------------------------------------------------------------------------

type Events = Arc<Mutex<Vec<(Instant, Vec<DownloadUpdate>)>>>;

struct Fixture {
    server: TestServer,
    manager: Manager,
    dir: PathBuf,
    _root: tempfile::TempDir,
    events: Events,
}

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::from_millis(10),
        max_delay: Duration::from_millis(40),
    }
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("downloads");
    let db = Arc::new(Db::open_in_memory().unwrap());
    let manager = Manager::new(db, dir.clone(), fast_retry());
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    manager.set_sink(Arc::new(move |batch| {
        sink.lock().unwrap().push((Instant::now(), batch));
    }));
    Fixture {
        server: TestServer::start(),
        manager,
        dir,
        _root: root,
        events,
    }
}

fn layout(album: &str, title: &str, track: u32) -> TrackLayout {
    TrackLayout {
        server_name: "Home".into(),
        album_artist: "Aurora Lane".into(),
        album: album.into(),
        title: title.into(),
        disc_number: Some(1),
        track_number: Some(track),
        disc_total: Some(1),
    }
}

impl Fixture {
    fn job(&self, track_id: &str, path: &str, album: &str, title: &str, number: u32) -> EnqueueJob {
        EnqueueJob {
            server_id: "s".into(),
            track_id: track_id.into(),
            quality: "original".into(),
            track_json: format!("{{\"id\":\"{track_id}\"}}"),
            individual: false,
            source: Source {
                url: self.server.url(path),
                headers: vec![("X-Test".into(), "1".into())],
                allow_insecure_tls: false,
            },
            layout: layout(album, title, number),
            container: Some("flac".into()),
            cover: None,
        }
    }

    fn row(&self, track_id: &str) -> Option<store::TrackRow> {
        self.manager
            .db()
            .with(|c| store::get_track(c, &TrackKey::new("s", track_id)))
            .unwrap()
    }

    fn state(&self, track_id: &str) -> Option<String> {
        self.row(track_id).map(|r| r.state)
    }

    fn wait_state(&self, track_id: &str, state: &str) {
        let ok = wait(Duration::from_secs(15), || {
            self.state(track_id).as_deref() == Some(state)
        });
        assert!(
            ok,
            "track {track_id} never reached {state}; now {:?}",
            self.row(track_id).map(|r| (r.state, r.error))
        );
    }

    fn wait_idle(&self) {
        assert!(
            wait(Duration::from_secs(15), || !self.manager.is_busy()),
            "still busy"
        );
    }

    fn part_path(&self, track_id: &str) -> PathBuf {
        self.dir
            .join(PARTIAL_DIR)
            .join(paths::part_file_name("s", track_id, "original"))
    }

    fn updates_for(&self, track_id: &str) -> Vec<DownloadUpdate> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, batch)| batch.iter().cloned())
            .filter(|u| u.track_id == track_id)
            .collect()
    }

    fn files(&self) -> Vec<String> {
        let mut files: Vec<String> = files_below(&self.dir).into_iter().collect();
        files.sort();
        files
    }
}

fn wait(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    cond()
}

// --- Transfer ------------------------------------------------------------------------------------

fn client() -> musify_audio::source::BlockingClient {
    musify_audio::source::build_http_client(false).unwrap()
}

fn source(server: &TestServer, path: &str) -> Source {
    Source {
        url: server.url(path),
        headers: vec![],
        allow_insecure_tls: false,
    }
}

#[test]
fn transfer_resumes_with_a_range_request() {
    let server = TestServer::start();
    let bytes = data(100_000, 1);
    server.put("/a", bytes.clone());
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("a.part");
    std::fs::write(&part, &bytes[..40_000]).unwrap();

    let mut last = (0, None);
    let fetched = transfer::fetch_to_part(
        &client(),
        &source(&server, "/a"),
        &part,
        &AtomicBool::new(false),
        &mut |done, total| last = (done, total),
    )
    .unwrap();

    assert_eq!(fetched.bytes, 100_000);
    assert_eq!(std::fs::read(&part).unwrap(), bytes);
    assert_eq!(
        server.requests_for("/a"),
        vec![Some("bytes=40000-".to_string())]
    );
    assert_eq!(last, (100_000, Some(100_000)));
    assert_eq!(fetched.content_type.as_deref(), Some("audio/flac"));
}

#[test]
fn transfer_restarts_when_the_server_answers_200_to_a_range() {
    let server = TestServer::start();
    server.behave(|b| b.ranges = false);
    let bytes = data(50_000, 2);
    server.put("/a", bytes.clone());
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("a.part");
    // Garbage from an earlier attempt must not end up in the file.
    std::fs::write(&part, vec![0xEE; 20_000]).unwrap();

    transfer::fetch_to_part(
        &client(),
        &source(&server, "/a"),
        &part,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap();

    assert_eq!(std::fs::read(&part).unwrap(), bytes);
}

#[test]
fn transfer_accepts_a_complete_partial_file_via_416() {
    let server = TestServer::start();
    let bytes = data(10_000, 3);
    server.put("/a", bytes.clone());
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("a.part");
    std::fs::write(&part, &bytes).unwrap();

    let fetched = transfer::fetch_to_part(
        &client(),
        &source(&server, "/a"),
        &part,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(fetched.bytes, 10_000);
    assert_eq!(std::fs::read(&part).unwrap(), bytes);
}

#[test]
fn transfer_drops_an_oversized_partial_file_and_reports_incomplete() {
    let server = TestServer::start();
    server.put("/a", data(1_000, 4));
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("a.part");
    std::fs::write(&part, vec![1; 5_000]).unwrap();

    let err = transfer::fetch_to_part(
        &client(),
        &source(&server, "/a"),
        &part,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, TransferError::Incomplete);
    assert!(err.retryable());
    assert!(!part.exists());
}

#[test]
fn transfer_reports_a_cut_connection_as_incomplete_and_keeps_the_bytes() {
    let server = TestServer::start();
    server.behave(|b| b.cut_first_after = Some(30_000));
    server.put("/a", data(100_000, 5));
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("a.part");

    let err = transfer::fetch_to_part(
        &client(),
        &source(&server, "/a"),
        &part,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert!(err.retryable(), "{err:?}");
    let kept = std::fs::metadata(&part).unwrap().len();
    assert!((1..100_000).contains(&kept), "kept {kept}");
}

#[test]
fn transfer_errors_do_not_contain_the_url() {
    let server = TestServer::start();
    let dir = tempfile::tempdir().unwrap();
    let secret = Source {
        url: format!(
            "http://127.0.0.1:1/stream?t=supersecret&s=salt{}",
            server.addr.port()
        ),
        headers: vec![],
        allow_insecure_tls: false,
    };
    let err = transfer::fetch_to_part(
        &client(),
        &secret,
        &dir.path().join("x.part"),
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap_err();
    let message = err.message();
    assert!(
        !message.contains("supersecret") && !message.contains("salt"),
        "{message}"
    );
}

// --- Manager -------------------------------------------------------------------------------------

#[test]
fn downloads_a_track_into_the_library_layout() {
    let f = fixture();
    let bytes = data(200_000, 7);
    f.server.put("/t1", bytes.clone());
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "Morning Static", "Song 1", 1)])
        .unwrap();
    f.wait_state("t1", "done");

    let row = f.row("t1").unwrap();
    assert_eq!(
        row.path.as_deref(),
        Some("Home/Aurora Lane/Morning Static/01 Song 1.flac")
    );
    assert_eq!(row.size_bytes, 200_000);
    assert_eq!(row.container.as_deref(), Some("flac"));
    assert_eq!(
        std::fs::read(f.dir.join("Home/Aurora Lane/Morning Static/01 Song 1.flac")).unwrap(),
        bytes
    );
    assert_eq!(f.server.requests_for("/t1").len(), 1);
    // The partial file is gone.
    assert!(!f.part_path("t1").exists());

    assert!(wait(Duration::from_secs(2), || f
        .updates_for("t1")
        .last()
        .is_some_and(|u| u.state == "done")));
    let states: Vec<String> = f.updates_for("t1").into_iter().map(|u| u.state).collect();
    // State transitions only ever move forward: queued → downloading → done.
    let rank = |s: &str| {
        ["queued", "downloading", "done"]
            .iter()
            .position(|x| *x == s)
            .unwrap()
    };
    assert!(
        states.windows(2).all(|w| rank(&w[0]) <= rank(&w[1])),
        "{states:?}"
    );
    assert_eq!(states.last().map(String::as_str), Some("done"));
    let done = f.updates_for("t1").pop().unwrap();
    assert_eq!(done.size_bytes, 200_000);
    assert!(done.path.unwrap().ends_with("01 Song 1.flac"));
}

#[test]
fn resumes_an_interrupted_download_from_the_partial_file() {
    let f = fixture();
    let bytes = data(300_000, 8);
    f.server.put("/t1", bytes.clone());
    // What a previous run left behind: a partial file and a row that is still queued.
    std::fs::create_dir_all(f.dir.join(PARTIAL_DIR)).unwrap();
    std::fs::write(f.part_path("t1"), &bytes[..120_000]).unwrap();

    f.manager
        .enqueue(vec![f.job("t1", "/t1", "Morning Static", "Song 1", 1)])
        .unwrap();
    f.wait_state("t1", "done");

    assert_eq!(
        f.server.requests_for("/t1"),
        vec![Some("bytes=120000-".to_string())]
    );
    let path = f.dir.join(f.row("t1").unwrap().path.unwrap());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn restarts_from_zero_when_the_server_does_not_support_ranges() {
    let f = fixture();
    f.server.behave(|b| b.ranges = false);
    let bytes = data(100_000, 9);
    f.server.put("/t1", bytes.clone());
    std::fs::create_dir_all(f.dir.join(PARTIAL_DIR)).unwrap();
    std::fs::write(f.part_path("t1"), vec![0u8; 50_000]).unwrap();

    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");
    let path = f.dir.join(f.row("t1").unwrap().path.unwrap());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn retries_after_a_cut_connection_and_resumes() {
    let f = fixture();
    f.server.behave(|b| b.cut_first_after = Some(60_000));
    let bytes = data(250_000, 10);
    f.server.put("/t1", bytes.clone());
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");

    let requests = f.server.requests_for("/t1");
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert_eq!(requests[0], None);
    assert!(requests[1].as_deref().unwrap().starts_with("bytes="));
    let path = f.dir.join(f.row("t1").unwrap().path.unwrap());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn retries_server_errors_with_backoff_and_then_succeeds() {
    let f = fixture();
    f.server.behave(|b| b.fail_first = 2);
    f.server.put("/t1", data(10_000, 11));
    let start = Instant::now();
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");
    assert_eq!(f.server.requests_for("/t1").len(), 3);
    // Two waits: 10 ms and 20 ms.
    assert!(start.elapsed() >= Duration::from_millis(30));
}

#[test]
fn fails_after_the_last_attempt_without_leaking_the_url() {
    let f = fixture();
    f.server.behave(|b| b.fail_first = usize::MAX);
    f.server.put("/t1", data(1_000, 12));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "failed");

    let row = f.row("t1").unwrap();
    assert_eq!(row.error.as_deref(), Some("HTTP status 500"));
    assert_eq!(f.server.requests_for("/t1").len(), 3);
    assert!(!row.error.unwrap().contains("127.0.0.1"));
    assert!(row.path.is_none());
}

#[test]
fn a_missing_file_is_not_retried() {
    let f = fixture();
    f.manager
        .enqueue(vec![f.job("t1", "/nope", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "failed");
    assert_eq!(f.server.requests_for("/nope").len(), 1);
    assert_eq!(
        f.row("t1").unwrap().error.as_deref(),
        Some("HTTP status 404")
    );
}

#[test]
fn a_failed_track_starts_again_when_it_is_queued_again() {
    let f = fixture();
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "failed");
    f.wait_idle();

    f.server.put("/t1", data(5_000, 13));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");
    assert_eq!(f.row("t1").unwrap().error, None);
}

#[test]
fn runs_at_most_three_downloads_at_once() {
    let f = fixture();
    f.server
        .behave(|b| b.chunk_delay = Duration::from_millis(15));
    let mut jobs = Vec::new();
    for n in 0..8 {
        let path = format!("/t{n}");
        f.server.put(&path, data(160_000, n as u8));
        jobs.push(f.job(
            &format!("t{n}"),
            &path,
            "A",
            &format!("Song {n}"),
            n as u32 + 1,
        ));
    }
    f.manager.enqueue(jobs).unwrap();
    for n in 0..8 {
        f.wait_state(&format!("t{n}"), "done");
    }
    assert_eq!(f.server.max_concurrent(), PARALLEL);
}

#[test]
fn cancelling_a_running_download_removes_its_files_and_row() {
    let f = fixture();
    f.server
        .behave(|b| b.chunk_delay = Duration::from_millis(20));
    f.server.put("/t1", data(2_000_000, 14));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    assert!(wait(Duration::from_secs(10), || f
        .part_path("t1")
        .metadata()
        .is_ok_and(|m| m.len() > 0)));

    f.manager
        .remove_tracks(&[TrackKey::new("s", "t1")])
        .unwrap();
    assert!(f.row("t1").is_none());
    f.wait_idle();
    assert!(wait(Duration::from_secs(5), || !f.part_path("t1").exists()));
    assert!(f.files().is_empty(), "{:?}", f.files());
    assert!(wait(Duration::from_secs(2), || f
        .updates_for("t1")
        .last()
        .is_some_and(|u| u.state == "removed")));
}

#[test]
fn cancelling_a_queued_download_never_starts_it() {
    let f = fixture();
    f.server
        .behave(|b| b.chunk_delay = Duration::from_millis(20));
    let mut jobs = Vec::new();
    for n in 0..5 {
        let path = format!("/t{n}");
        f.server.put(&path, data(400_000, n as u8));
        jobs.push(f.job(
            &format!("t{n}"),
            &path,
            "A",
            &format!("Song {n}"),
            n as u32 + 1,
        ));
    }
    f.manager.enqueue(jobs).unwrap();
    // t3 and t4 are still waiting behind the first three.
    f.manager
        .remove_tracks(&[TrackKey::new("s", "t3"), TrackKey::new("s", "t4")])
        .unwrap();
    for n in 0..3 {
        f.wait_state(&format!("t{n}"), "done");
    }
    f.wait_idle();
    assert!(f.server.requests_for("/t3").is_empty() && f.server.requests_for("/t4").is_empty());
    assert!(f.row("t3").is_none());
}

#[test]
fn removing_a_finished_track_deletes_the_file_and_empty_folders() {
    let f = fixture();
    f.server.put("/t1", data(5_000, 15));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");
    assert_eq!(f.files(), vec!["Home/Aurora Lane/A/01 Song.flac"]);

    f.manager
        .remove_tracks(&[TrackKey::new("s", "t1")])
        .unwrap();
    assert!(f.row("t1").is_none());
    assert!(f.files().is_empty());
    assert!(!f.dir.join("Home").exists(), "empty folders are cleaned up");
}

#[test]
fn queueing_a_finished_track_again_does_nothing_but_a_missing_file_is_fetched_again() {
    let f = fixture();
    f.server.put("/t1", data(5_000, 16));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_state("t1", "done");

    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    f.wait_idle();
    assert_eq!(f.server.requests_for("/t1").len(), 1);

    // The user deleted the file by hand: the next queueing downloads it again.
    std::fs::remove_file(f.dir.join("Home/Aurora Lane/A/01 Song.flac")).unwrap();
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    assert!(wait(Duration::from_secs(10), || f
        .server
        .requests_for("/t1")
        .len()
        == 2));
    f.wait_state("t1", "done");
    assert!(wait(Duration::from_secs(5), || f
        .dir
        .join("Home/Aurora Lane/A/01 Song.flac")
        .is_file()));
}

#[test]
fn tracks_with_the_same_name_get_distinct_files() {
    let f = fixture();
    f.server.put("/a", data(3_000, 17));
    f.server.put("/b", data(3_100, 18));
    f.manager
        .enqueue(vec![
            f.job("a", "/a", "Album", "Same", 1),
            f.job("b", "/b", "Album", "Same", 1),
        ])
        .unwrap();
    f.wait_state("a", "done");
    f.wait_state("b", "done");
    assert_eq!(
        f.files(),
        vec![
            "Home/Aurora Lane/Album/01 Same (2).flac",
            "Home/Aurora Lane/Album/01 Same.flac"
        ]
    );
}

#[test]
fn the_album_cover_is_saved_once_per_folder() {
    let f = fixture();
    let png = {
        let mut v = vec![0x89, b'P', b'N', b'G'];
        v.extend(data(500, 3));
        v
    };
    f.server.put("/cover", png.clone());
    let mut jobs = Vec::new();
    for n in 1..=3 {
        let path = format!("/t{n}");
        f.server.put(&path, data(4_000, n as u8));
        let mut job = f.job(&format!("t{n}"), &path, "Album", &format!("Song {n}"), n);
        job.cover = Some(CoverJob {
            cover_ref: "al1".into(),
            source: source(&f.server, "/cover"),
        });
        jobs.push(job);
    }
    f.manager.enqueue(jobs).unwrap();
    for n in 1..=3 {
        f.wait_state(&format!("t{n}"), "done");
    }
    assert!(wait(Duration::from_secs(5), || f
        .dir
        .join("Home/Aurora Lane/Album/cover.png")
        .is_file()));
    f.wait_idle();
    assert_eq!(
        f.server.requests_for("/cover").len(),
        1,
        "cover fetched once"
    );
    assert_eq!(
        std::fs::read(f.dir.join("Home/Aurora Lane/Album/cover.png")).unwrap(),
        png
    );
    let mapped = f
        .manager
        .db()
        .with(|c| store::get_cover_path(c, "s", "al1"))
        .unwrap();
    assert_eq!(mapped.as_deref(), Some("Home/Aurora Lane/Album/cover.png"));

    // Removing the last track also removes the cover and the folders.
    let keys: Vec<_> = (1..=3)
        .map(|n| TrackKey::new("s", format!("t{n}")))
        .collect();
    f.manager.remove_tracks(&keys).unwrap();
    assert!(f.files().is_empty(), "{:?}", f.files());
    assert_eq!(
        f.manager
            .db()
            .with(|c| store::get_cover_path(c, "s", "al1"))
            .unwrap(),
        None
    );
}

fn collection(kind: &str, id: &str, tracks: &[&str]) -> CollectionInput {
    CollectionInput {
        server_id: "s".into(),
        kind: kind.into(),
        item_id: id.into(),
        name: id.into(),
        json: "{}".into(),
        track_ids: tracks.iter().map(|t| t.to_string()).collect(),
    }
}

#[test]
fn collections_keep_shared_tracks_and_delete_the_rest() {
    let f = fixture();
    for id in ["t1", "t2", "t3", "t4"] {
        f.server.put(&format!("/{id}"), data(2_000, id.len() as u8));
    }
    let job = |id: &str, n: u32| f.job(id, &format!("/{id}"), "Album", id, n);

    f.manager
        .set_collection(
            collection("album", "al", &["t1", "t2"]),
            vec![job("t1", 1), job("t2", 2)],
        )
        .unwrap();
    f.manager
        .set_collection(
            collection("playlist", "pl", &["t2", "t3"]),
            vec![job("t2", 2), job("t3", 3)],
        )
        .unwrap();
    // t4 is downloaded on its own.
    let mut single = job("t4", 4);
    single.individual = true;
    f.manager.enqueue(vec![single]).unwrap();
    for id in ["t1", "t2", "t3", "t4"] {
        f.wait_state(id, "done");
    }

    // The album goes away: t1 is gone, t2 stays because the playlist lists it.
    f.manager.remove_collection("s", "album", "al").unwrap();
    assert!(f.row("t1").is_none());
    assert_eq!(f.state("t2").as_deref(), Some("done"));

    // The playlist loses t3 on a sync; t2 is orphaned only when the playlist drops it too.
    f.manager
        .set_collection(collection("playlist", "pl", &["t2"]), vec![job("t2", 2)])
        .unwrap();
    assert!(f.row("t3").is_none());
    assert_eq!(f.state("t2").as_deref(), Some("done"));

    f.manager.remove_collection("s", "playlist", "pl").unwrap();
    assert!(f.row("t2").is_none());
    // The individually downloaded track survives every collection change.
    assert_eq!(f.state("t4").as_deref(), Some("done"));
    assert_eq!(f.files().len(), 1);

    // Removing it individually deletes it for good.
    assert!(
        f.manager
            .remove_individual(&TrackKey::new("s", "t4"))
            .unwrap()
    );
    assert!(f.files().is_empty());
}

#[test]
fn removing_the_individual_download_keeps_tracks_that_a_collection_lists() {
    let f = fixture();
    f.server.put("/t1", data(2_000, 1));
    let mut job = f.job("t1", "/t1", "Album", "Song", 1);
    job.individual = true;
    f.manager
        .set_collection(collection("album", "al", &["t1"]), vec![job])
        .unwrap();
    f.wait_state("t1", "done");

    assert!(
        !f.manager
            .remove_individual(&TrackKey::new("s", "t1"))
            .unwrap()
    );
    assert_eq!(f.state("t1").as_deref(), Some("done"));
    assert!(!f.row("t1").unwrap().individual);
    f.manager.remove_collection("s", "album", "al").unwrap();
    assert!(f.row("t1").is_none());
}

#[test]
fn remove_all_deletes_everything() {
    let f = fixture();
    for id in ["t1", "t2"] {
        f.server.put(&format!("/{id}"), data(2_000, 5));
    }
    f.manager
        .set_collection(
            collection("album", "al", &["t1"]),
            vec![f.job("t1", "/t1", "Album", "One", 1)],
        )
        .unwrap();
    let mut single = f.job("t2", "/t2", "Other", "Two", 1);
    single.individual = true;
    f.manager.enqueue(vec![single]).unwrap();
    f.wait_state("t1", "done");
    f.wait_state("t2", "done");

    f.manager.remove_all().unwrap();
    let listing = f.manager.list("s").unwrap();
    assert!(listing.tracks.is_empty() && listing.collections.is_empty());
    assert!(f.files().is_empty(), "{:?}", f.files());
}

#[test]
fn rows_left_downloading_are_queued_again_after_a_restart() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    let key = TrackKey::new("s", "t1");
    db.with(|c| {
        store::upsert_queued(
            c,
            &store::QueuedTrack {
                key: &key,
                quality: "original",
                container: None,
                track_json: "{}",
                individual: true,
            },
        )?;
        store::set_state(c, &key, store::STATE_DOWNLOADING, None)
    })
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let manager = Manager::new(Arc::clone(&db), root.path().join("d"), fast_retry());
    let state = db
        .with(|c| store::get_track(c, &key))
        .unwrap()
        .unwrap()
        .state;
    assert_eq!(state, "queued");
    // Nothing is downloaded until the frontend hands the source over.
    assert!(!manager.is_busy());
}

#[test]
fn progress_events_are_batched_to_about_ten_per_second() {
    let f = fixture();
    f.server
        .behave(|b| b.chunk_delay = Duration::from_millis(2));
    let mut jobs = Vec::new();
    for n in 0..3 {
        let path = format!("/t{n}");
        f.server.put(&path, data(2_000_000, n as u8));
        jobs.push(f.job(
            &format!("t{n}"),
            &path,
            "A",
            &format!("Song {n}"),
            n as u32 + 1,
        ));
    }
    let started = Instant::now();
    f.manager.enqueue(jobs).unwrap();
    for n in 0..3 {
        f.wait_state(&format!("t{n}"), "done");
    }
    thread::sleep(Duration::from_millis(250));
    let elapsed = started.elapsed().as_secs_f64();

    let events = f.events.lock().unwrap();
    let batches = events.len();
    assert!(batches >= 3, "expected progress, got {batches} batches");
    assert!(
        batches as f64 <= elapsed * 10.0 + 3.0,
        "{batches} batches in {elapsed:.2}s is more than 10 per second"
    );
    // Consecutive batches are at least ~80 ms apart.
    let gaps: Vec<_> = events.windows(2).map(|w| w[1].0 - w[0].0).collect();
    assert!(
        gaps.iter().all(|g| *g >= Duration::from_millis(60)),
        "{gaps:?}"
    );
}

#[test]
fn moving_the_folder_updates_paths_and_refuses_while_busy() {
    let f = fixture();
    f.server
        .behave(|b| b.chunk_delay = Duration::from_millis(20));
    f.server.put("/t1", data(1_000_000, 20));
    f.manager
        .enqueue(vec![f.job("t1", "/t1", "A", "Song", 1)])
        .unwrap();
    let target = f.dir.parent().unwrap().join("moved");
    assert_eq!(
        f.manager.move_folder(&target, &mut |_| {}),
        Err("busy".to_string())
    );
    f.wait_state("t1", "done");
    f.wait_idle();

    let mut last = None;
    f.manager
        .move_folder(&target, &mut |p| last = Some(p))
        .unwrap();
    assert!(last.unwrap().done);
    assert_eq!(f.manager.dir(), target);

    let listing = f.manager.list("s").unwrap();
    let path = PathBuf::from(listing.tracks[0].absolute_path.clone().unwrap());
    assert!(path.starts_with(&target) && path.is_file(), "{path:?}");
    let stored = f
        .manager
        .db()
        .with(|c| store::get_setting(c, store::SETTING_DIR))
        .unwrap();
    assert_eq!(stored.as_deref(), Some(target.to_string_lossy().as_ref()));
    assert!(!Path::new(&f.dir.join("Home")).exists());
}

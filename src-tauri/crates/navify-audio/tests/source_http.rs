//! HTTP source behaviour against an in-process test server.

mod source_support;

use std::io::SeekFrom;
use std::sync::Arc;
use std::time::Duration;

use navify_audio::api::{SourceLocation, TimeOffsetParam, TimeOffsetUnit};
use navify_audio::source::{SourceError, SourceEvent, build_http_client, url_with_time_offset};
use source_support::*;

const MB: usize = 1024 * 1024;

#[test]
fn random_seek_and_read_matches_original() {
    let data = test_data(6 * MB, 1);
    let server = TestServer::start(
        data.clone(),
        ServerConfig { throttle: Some((64 * 1024, Duration::from_millis(5))), ..Default::default() },
    );
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _events) = manager(dir.path(), 1 << 30);
    let loc = http_location(server.url("/rest/stream?id=1"), "srv:1:raw");
    let opened = mgr.open(&loc, 0).unwrap();
    assert_eq!(opened.starts_at_ms, 0);
    let mut src = opened.source;
    assert!(src.is_seekable());
    assert_eq!(src.byte_len(), Some(data.len() as u64));

    let mut rng = Rng::new(42);
    let len = data.len() as u64;
    for i in 0..300 {
        let pos = match i % 10 {
            0 => {
                let back = 1 + rng.below(200_000) as i64;
                src.seek(SeekFrom::End(-back)).unwrap()
            }
            1 => {
                let cur = src.stream_position().unwrap() as i64;
                let delta = rng.below(100_000) as i64 - 50_000;
                let target = (cur + delta).clamp(0, len as i64);
                src.seek(SeekFrom::Current(target - cur)).unwrap()
            }
            _ => src.seek(SeekFrom::Start(rng.below(len))).unwrap(),
        };
        let want = 1 + rng.below(100_000) as usize;
        let mut buf = vec![0u8; want];
        let n = read_full(src.as_mut(), &mut buf).unwrap();
        let end = (pos as usize + want).min(data.len());
        assert_eq!(n, end - pos as usize, "short read at {pos}");
        assert!(buf[..n] == data[pos as usize..end], "data mismatch at {pos} (+{n})");
    }
    // Seeking far ahead of the download must have produced additional range requests.
    assert!(server.requests() > 1, "expected range requests, got {}", server.requests());
    assert!(server.log().iter().all(|r| r.range.as_deref().is_some_and(|r| r.starts_with("bytes="))));
}

#[test]
fn throttled_server_reports_buffering() {
    let data = test_data(MB, 2);
    let server = TestServer::start(
        data.clone(),
        ServerConfig { throttle: Some((32 * 1024, Duration::from_millis(300))), ..Default::default() },
    );
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let key = "srv:slow:raw";
    let mut src = mgr.open(&http_location(server.url("/slow"), key), 0).unwrap().source;
    let mut buf = vec![0u8; 200 * 1024];
    let n = read_full(src.as_mut(), &mut buf).unwrap();
    assert_eq!(n, buf.len());
    assert!(buf == data[..buf.len()]);
    let ev = events.all();
    let on = ev.iter().position(|e| *e == SourceEvent::Buffering { cache_key: key.into(), active: true });
    let off = ev.iter().rposition(|e| *e == SourceEvent::Buffering { cache_key: key.into(), active: false });
    assert!(on.is_some() && off.is_some() && on < off, "events: {ev:?}");
    // Balanced on/off.
    let ons = ev.iter().filter(|e| matches!(e, SourceEvent::Buffering { active: true, .. })).count();
    let offs = ev.iter().filter(|e| matches!(e, SourceEvent::Buffering { active: false, .. })).count();
    assert_eq!(ons, offs);
}

#[test]
fn connection_drops_resume_at_offset() {
    let data = test_data(4 * MB, 3);
    let server = TestServer::start(data.clone(), ServerConfig { drop_after: Some(300_000), ..Default::default() });
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let mut src = mgr.open(&http_location(server.url("/drop"), "srv:drop:raw"), 0).unwrap().source;
    let got = read_all(src.as_mut());
    assert!(got == data, "resumed data differs");
    assert!(server.requests() >= data.len() / 300_000, "requests: {}", server.requests());
    events.wait_completed("srv:drop:raw");
    // Resumed requests start where the previous one stopped.
    let log = server.log();
    assert!(log.iter().any(|r| r.range.as_deref() == Some("bytes=300000-")), "{log:?}");
}

#[test]
fn server_errors_are_retried() {
    let data = test_data(MB, 4);
    let server = TestServer::start(data.clone(), ServerConfig { fail_first: 2, ..Default::default() });
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _events) = manager(dir.path(), 1 << 30);
    let mut src = mgr.open(&http_location(server.url("/flaky"), "srv:flaky:raw"), 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    assert_eq!(server.requests(), 3);
}

#[test]
fn persistent_http_errors_surface() {
    let data = test_data(1000, 5);
    let server = TestServer::start(data, ServerConfig { fail_first: usize::MAX, ..Default::default() });
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _events) = manager(dir.path(), 1 << 30);
    let err = mgr.open(&http_location(server.url("/dead?t=secrettoken"), "srv:dead:raw"), 0).err().unwrap();
    assert!(matches!(err, SourceError::Http(500)), "{err}");
    assert!((3..=5).contains(&server.requests()), "attempts: {}", server.requests());
}

#[test]
fn network_errors_never_contain_the_url() {
    // Bind and drop a listener to get a port that refuses connections.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let url = format!("http://alice:pw0rd@127.0.0.1:{port}/rest/stream.view?u=alice&t=secrettoken&s=saltysalt");
    let dir = tempfile::tempdir().unwrap();
    let (mgr, _events) = manager(dir.path(), 1 << 30);
    let err = mgr.open(&http_location(url, "srv:refused:raw"), 0).err().unwrap();
    let msg = err.to_string();
    assert!(matches!(err, SourceError::Network(_)), "{msg}");
    for secret in ["secrettoken", "saltysalt", "pw0rd", "stream.view"] {
        assert!(!msg.contains(secret), "error leaks {secret}: {msg}");
    }
}

fn forward_only_stream(content_length: bool) {
    let data = test_data(3 * MB, 6);
    let server = TestServer::start(
        data.clone(),
        ServerConfig {
            ranges: false,
            content_length,
            throttle: Some((64 * 1024, Duration::from_millis(10))),
            ..Default::default()
        },
    );
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let key = "srv:transcode:mp3-320";
    let loc = http_location(server.url("/transcode"), key);
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(!src.is_seekable());
    assert_eq!(src.byte_len(), content_length.then_some(data.len() as u64));
    // Far beyond the downloaded data: refused.
    assert!(src.seek(SeekFrom::Start(data.len() as u64 - 10)).is_err());
    // Read a bit, seek back within downloaded data, then read everything.
    let head = read_exact_at(src.as_mut(), 0, 100_000);
    assert!(head == data[..100_000]);
    assert_eq!(src.seek(SeekFrom::Start(10)).unwrap(), 10);
    src.seek(SeekFrom::Start(0)).unwrap();
    assert!(read_all(src.as_mut()) == data);
    events.wait_completed(key);
    assert!(src.is_seekable(), "complete entries are seekable");
    assert_eq!(src.byte_len(), Some(data.len() as u64));
    drop(src);
    assert!(mgr.is_available_offline(&loc));

    let requests = server.requests();
    let mut again = mgr.open(&loc, 0).unwrap().source;
    assert!(again.is_seekable());
    assert_eq!(again.byte_len(), Some(data.len() as u64));
    let tail = read_exact_at(again.as_mut(), data.len() as u64 - 5000, 5000);
    assert!(tail == data[data.len() - 5000..]);
    assert!(read_exact_at(again.as_mut(), 0, 1000) == data[..1000]);
    assert_eq!(server.requests(), requests, "complete entry must not touch the network");

    // A fresh manager on the same directory (app restart) also plays offline.
    drop(again);
    drop(mgr);
    let (mgr2, _ev2) = manager(dir.path(), 1 << 30);
    assert!(mgr2.is_available_offline(&loc));
    let mut src = mgr2.open(&loc, 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    assert_eq!(server.requests(), requests);
}

#[test]
fn status_200_stream_is_forward_only_then_cached() {
    forward_only_stream(true);
}

#[test]
fn status_200_stream_without_content_length() {
    forward_only_stream(false);
}

#[test]
fn concurrent_readers_share_one_download() {
    let data = test_data(4 * MB, 7);
    let server = TestServer::start(
        data.clone(),
        ServerConfig { throttle: Some((64 * 1024, Duration::from_millis(10))), ..Default::default() },
    );
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let mgr = Arc::new(mgr);
    let loc = http_location(server.url("/shared"), "srv:shared:raw");
    std::thread::scope(|s| {
        for _ in 0..3 {
            let (mgr, loc, data) = (mgr.clone(), loc.clone(), &data);
            s.spawn(move || {
                let mut src = mgr.open(&loc, 0).unwrap().source;
                assert!(read_all(src.as_mut()) == *data);
            });
        }
    });
    events.wait_completed("srv:shared:raw");
    assert_eq!(server.requests(), 1, "{:?}", server.log());
}

#[test]
fn time_offset_restart_builds_url_and_skips_main_cache() {
    let data = test_data(MB, 8);
    let server = TestServer::start(data.clone(), ServerConfig { ranges: false, content_length: false, ..Default::default() });
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);

    let seconds = TimeOffsetParam { param: "timeOffset".into(), unit: TimeOffsetUnit::Seconds };
    let key = "srv:t1:mp3-192";
    let loc = transcoded_location(server.url("/rest/stream?id=1&u=alice"), key, Some(seconds));
    let opened = mgr.open(&loc, 65_500).unwrap();
    assert_eq!(opened.starts_at_ms, 65_000);
    let mut src = opened.source;
    assert!(read_all(src.as_mut()) == data);
    assert_eq!(server.log().last().unwrap().target, "/rest/stream?id=1&u=alice&timeOffset=65");
    // Nothing is stored under the main key, and no Completed event for it.
    let main = hash_key_files(key);
    assert!(dir_names(dir.path()).iter().all(|n| !main.contains(n)));
    assert!(!events.completed(key));
    drop(src);
    assert!(wait_until(Duration::from_secs(5), || dir_names(dir.path()).is_empty()), "{:?}", dir_names(dir.path()));
    assert!(!mgr.is_available_offline(&loc));

    let ticks = TimeOffsetParam { param: "StartTimeTicks".into(), unit: TimeOffsetUnit::Ticks };
    let loc = transcoded_location(server.url("/Audio/abc/universal?api_key=k"), "srv:t2:aac", Some(ticks));
    let opened = mgr.open(&loc, 65_500).unwrap();
    assert_eq!(opened.starts_at_ms, 65_500);
    assert_eq!(server.log().last().unwrap().target, "/Audio/abc/universal?api_key=k&StartTimeTicks=655000000");
    drop(opened);

    // start_ms = 0, or no time_offset: normal cached stream, starts at 0.
    let loc = transcoded_location(server.url("/rest/stream?id=3"), "srv:t3:mp3", None);
    let opened = mgr.open(&loc, 30_000).unwrap();
    assert_eq!(opened.starts_at_ms, 0);
    assert!(server.log().last().unwrap().target == "/rest/stream?id=3");
}

fn hash_key_files(key: &str) -> Vec<String> {
    let h = hash_hex(key);
    vec![format!("{h}.data"), format!("{h}.meta")]
}

#[test]
fn time_offset_url_construction() {
    let s = TimeOffsetParam { param: "timeOffset".into(), unit: TimeOffsetUnit::Seconds };
    let t = TimeOffsetParam { param: "StartTimeTicks".into(), unit: TimeOffsetUnit::Ticks };
    assert_eq!(
        url_with_time_offset("https://h/rest/stream?id=1", &s, 125_999).unwrap(),
        ("https://h/rest/stream?id=1&timeOffset=125".to_string(), 125_000)
    );
    assert_eq!(
        url_with_time_offset("https://h/Audio/1/universal", &t, 2_500).unwrap(),
        ("https://h/Audio/1/universal?StartTimeTicks=25000000".to_string(), 2_500)
    );
    assert_eq!(url_with_time_offset("https://h/s?timeOffset=1", &s, 7_000).unwrap().0, "https://h/s?timeOffset=7");
}

#[test]
fn cache_files_never_contain_url_parts() {
    let data = test_data(MB, 9);
    let server = TestServer::start(data.clone(), ServerConfig::default());
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let key = "server-1:track-42:raw";
    let loc = http_location(server.url("/rest/stream.view?u=alice&t=secrettoken&s=saltysalt&id=42"), key);
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    events.wait_completed(key);
    drop(src);
    let h = hash_hex(key);
    assert!(wait_until(Duration::from_secs(5), || {
        let mut names = dir_names(dir.path());
        names.sort();
        names == vec![format!("{h}.data"), format!("{h}.meta")]
    }));
    let forbidden = ["alice", "secrettoken", "saltysalt", "127.0.0.1", "stream.view", "server-1", "track"];
    for name in dir_names(dir.path()) {
        let (stem, ext) = name.split_once('.').unwrap();
        assert!(stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{name}");
        assert!(ext == "data" || ext == "meta", "{name}");
        for f in forbidden {
            assert!(!name.contains(f), "{name} contains {f}");
        }
    }
    let meta = std::fs::read_to_string(dir.path().join(format!("{h}.meta"))).unwrap();
    for f in ["alice", "secrettoken", "saltysalt", "127.0.0.1", "stream.view", "server-1"] {
        assert!(!meta.contains(f), "metadata contains {f}");
    }
    let SourceEvent::Completed { path, .. } =
        events.all().into_iter().find(|e| matches!(e, SourceEvent::Completed { .. })).unwrap()
    else {
        unreachable!()
    };
    assert_eq!(path, dir.path().join(format!("{h}.data")));
}

#[test]
fn prefetch_downloads_in_background_and_cancel_keeps_partial() {
    let data = test_data(2 * MB, 10);
    let fast = TestServer::start(data.clone(), ServerConfig::default());
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let loc = http_location(fast.url("/next"), "srv:next:raw");
    mgr.prefetch(&loc);
    events.wait_completed("srv:next:raw");
    assert!(mgr.is_available_offline(&loc));
    let before = fast.requests();
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    assert_eq!(fast.requests(), before);
    drop(src);

    let slow = TestServer::start(
        data.clone(),
        ServerConfig { throttle: Some((32 * 1024, Duration::from_millis(20))), ..Default::default() },
    );
    let loc = http_location(slow.url("/later"), "srv:later:raw");
    mgr.prefetch(&loc);
    std::thread::sleep(Duration::from_millis(300));
    mgr.cancel_prefetch("srv:later:raw");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!mgr.is_available_offline(&loc));
    let h = hash_hex("srv:later:raw");
    let partial = std::fs::metadata(dir.path().join(format!("{h}.data"))).unwrap().len();
    assert!(partial > 0 && partial < data.len() as u64, "partial = {partial}");
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    // The resumed download started after the prefetched prefix.
    assert!(slow.log().iter().skip(1).any(|r| r.range.as_deref() != Some("bytes=0-")), "{:?}", slow.log());
}

#[test]
fn local_files_are_seekable_sources() {
    let data = test_data(300_000, 11);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("track.flac");
    std::fs::write(&path, &data).unwrap();
    let (mgr, _events) = manager(&dir.path().join("cache"), 1 << 30);
    let loc = SourceLocation::Local { path: path.clone() };
    assert!(mgr.is_available_offline(&loc));
    assert!(!mgr.is_available_offline(&SourceLocation::Local { path: dir.path().join("missing.flac") }));
    let opened = mgr.open(&loc, 5000).unwrap();
    assert_eq!(opened.starts_at_ms, 0);
    let mut src = opened.source;
    assert!(src.is_seekable());
    assert_eq!(src.byte_len(), Some(data.len() as u64));
    assert!(read_exact_at(src.as_mut(), 123_456, 1000) == data[123_456..124_456]);
    src.seek(SeekFrom::Current(-500)).unwrap();
    let mut b = [0u8; 10];
    read_full(src.as_mut(), &mut b).unwrap();
    assert!(b == data[123_956..123_966]);
    assert!(read_exact_at(src.as_mut(), 0, data.len()) == data);
    assert!(mgr.open(&SourceLocation::Local { path: dir.path().join("missing.flac") }, 0).is_err());
}

#[test]
fn tls_clients_build() {
    assert!(build_http_client(false).is_ok());
    assert!(build_http_client(true).is_ok());
}

#[test]
fn transcode_shorter_than_estimated_length_completes() {
    let data = test_data(MB, 12);
    let server = TestServer::start(
        data.clone(),
        ServerConfig { ranges: false, announce_len: Some(MB as u64 + 50_000), ..Default::default() },
    );
    let dir = tempfile::tempdir().unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let key = "srv:estimated:opus";
    let loc = http_location(server.url("/estimated"), key);
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert_eq!(src.byte_len(), Some(MB as u64 + 50_000));
    assert!(read_all(src.as_mut()) == data);
    events.wait_completed(key);
    assert_eq!(src.byte_len(), Some(data.len() as u64));
    drop(src);
    let h = hash_hex(key);
    assert_eq!(std::fs::metadata(dir.path().join(format!("{h}.data"))).unwrap().len(), data.len() as u64);
    assert!(mgr.is_available_offline(&loc));
}

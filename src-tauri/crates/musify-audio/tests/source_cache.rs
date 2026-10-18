//! Cache management: LRU eviction, clear, crash recovery, resume of partial entries.

mod source_support;

use std::io::Read;
use std::time::Duration;

use musify_audio::source::SourceError;

use source_support::*;

const MB: usize = 1024 * 1024;

fn data_file(dir: &std::path::Path, key: &str) -> std::path::PathBuf {
    dir.join(format!("{}.data", hash_hex(key)))
}

#[test]
fn lru_eviction_respects_limit_and_open_entries() {
    let data = test_data(MB, 20);
    let server = TestServer::start(data.clone(), ServerConfig::default());
    let dir = tempfile::tempdir().unwrap();
    let limit = (2 * MB + MB / 2) as u64;
    let (mgr, events) = manager(dir.path(), limit);
    let loc = |k: &str| http_location(server.url(&format!("/{k}")), k);

    // A stays open the whole time (and is the least recently used).
    let mut a = mgr.open(&loc("a"), 0).unwrap().source;
    assert!(read_all(a.as_mut()) == data);
    events.wait_completed("a");

    for k in ["b", "c", "d", "e"] {
        let mut src = mgr.open(&loc(k), 0).unwrap().source;
        assert!(read_all(src.as_mut()) == data);
        events.wait_completed(k);
        drop(src);
        assert!(
            data_file(dir.path(), "a").exists(),
            "open entry evicted after {k}"
        );
    }
    assert!(
        wait_until(Duration::from_secs(5), || mgr.cache_size() <= limit),
        "size {}",
        mgr.cache_size()
    );
    // Oldest closed entries went first; the newest survive.
    assert!(!data_file(dir.path(), "b").exists());
    assert!(!data_file(dir.path(), "c").exists());
    assert!(data_file(dir.path(), "e").exists());
    assert!(!mgr.is_available_offline(&loc("b")));
    assert!(mgr.is_available_offline(&loc("e")));

    // Shrinking the limit evicts everything that is not open.
    mgr.set_cache_limit(0);
    assert!(data_file(dir.path(), "a").exists());
    assert!(!data_file(dir.path(), "e").exists());
    assert_eq!(mgr.cache_size(), data.len() as u64);

    // clear_cache keeps the open entry.
    mgr.set_cache_limit(1 << 30);
    let mut f = mgr.open(&loc("f"), 0).unwrap().source;
    assert!(read_all(f.as_mut()) == data);
    drop(f);
    assert!(wait_until(Duration::from_secs(5), || {
        mgr.clear_cache().unwrap();
        !data_file(dir.path(), "f").exists()
    }));
    assert!(data_file(dir.path(), "a").exists());
    assert!(a.seek(std::io::SeekFrom::Start(0)).is_ok());
    assert!(read_all(a.as_mut()) == data);

    drop(a);
    assert!(wait_until(Duration::from_secs(5), || {
        mgr.clear_cache().unwrap();
        dir_names(dir.path()).is_empty()
    }));
    assert_eq!(mgr.cache_size(), 0);
}

#[test]
fn crashed_or_foreign_files_are_cleaned_up() {
    let dir = tempfile::tempdir().unwrap();
    let h = |k: &str| hash_hex(k);
    let p = |name: String| dir.path().join(name);
    // Garbage metadata.
    std::fs::write(p(format!("{}.meta", h("garbage"))), b"\x00\x01garbage").unwrap();
    std::fs::write(p(format!("{}.data", h("garbage"))), vec![7u8; 1000]).unwrap();
    // Half-written metadata (no trailing "end").
    std::fs::write(
        p(format!("{}.meta", h("half"))),
        "musify-cache 1\ntotal 1000\nseekable 1\ncomplete 0\naccess 5\nranges 0-500\n",
    )
    .unwrap();
    std::fs::write(p(format!("{}.data", h("half"))), vec![7u8; 500]).unwrap();
    // "Complete" metadata whose data file is truncated.
    std::fs::write(
        p(format!("{}.meta", h("trunc"))),
        "musify-cache 1\ntotal 1000\nseekable 1\ncomplete 1\naccess 5\nranges 0-1000\nend\n",
    )
    .unwrap();
    std::fs::write(p(format!("{}.data", h("trunc"))), vec![7u8; 10]).unwrap();
    // Orphans and leftovers.
    std::fs::write(p(format!("{}.data", h("orphan"))), vec![1u8; 100]).unwrap();
    std::fs::write(p(format!("{}.meta.tmp", h("tmp"))), b"x").unwrap();
    std::fs::write(p(format!("{}.stream", h("offset"))), b"x").unwrap();
    std::fs::write(p("notes.txt".into()), b"not ours").unwrap();

    let (mgr, _events) = manager(dir.path(), 1 << 30);
    let mut names = dir_names(dir.path());
    names.sort();
    // The truncated "complete" entry is kept as a partial entry (its metadata is well-formed).
    let mut expected = vec![
        format!("{}.data", h("trunc")),
        format!("{}.meta", h("trunc")),
        "notes.txt".to_string(),
    ];
    expected.sort();
    assert_eq!(names, expected);
    assert_eq!(mgr.cache_size(), 10);

    let loc = http_location("http://127.0.0.1:9/never".into(), "trunc");
    assert!(!mgr.is_available_offline(&loc));

    mgr.clear_cache().unwrap();
    assert_eq!(dir_names(dir.path()), vec!["notes.txt".to_string()]);
}

#[test]
fn partial_entry_resumes_after_restart() {
    let data = test_data(3 * MB, 21);
    let server = TestServer::start(
        data.clone(),
        ServerConfig {
            throttle: Some((64 * 1024, Duration::from_millis(20))),
            ..Default::default()
        },
    );
    let dir = tempfile::tempdir().unwrap();
    let key = "srv:resume:raw";
    let loc = http_location(server.url("/resume"), key);
    {
        let (mgr, _events) = manager(dir.path(), 1 << 30);
        let mut src = mgr.open(&loc, 0).unwrap().source;
        let head = read_exact_at(src.as_mut(), 0, 500_000);
        assert!(head == data[..500_000]);
        drop(src);
        // Let the download thread notice and persist its state.
        std::thread::sleep(Duration::from_millis(500));
    }
    let partial = std::fs::metadata(data_file(dir.path(), key)).unwrap().len();
    assert!(
        partial >= 500_000 && partial < data.len() as u64,
        "partial = {partial}"
    );
    let first_session_requests = server.requests();

    let (mgr, events) = manager(dir.path(), 1 << 30);
    assert!(mgr.cache_size() >= 500_000);
    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(src.is_seekable());
    assert_eq!(src.byte_len(), Some(data.len() as u64));
    assert!(read_all(src.as_mut()) == data);
    events.wait_completed(key);
    let log = server.log();
    let resumed = &log[first_session_requests..];
    assert!(!resumed.is_empty());
    assert!(
        resumed
            .iter()
            .all(|r| r.range.as_deref() != Some("bytes=0-")),
        "{resumed:?}"
    );
}

/// What Navidrome sends (with HTTP 200) for a track that no longer exists.
const GONE: &[u8] = br#"{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":70,"message":"data not found"}}}"#;

#[test]
fn server_error_documents_are_reported_and_never_cached() {
    // With the honest content type, and with a server that claims the error is audio.
    for content_type in ["application/json", "audio/mpeg"] {
        let server = TestServer::start(
            GONE.to_vec(),
            ServerConfig {
                content_type: content_type.into(),
                ..Default::default()
            },
        );
        let dir = tempfile::tempdir().unwrap();
        let (mgr, events) = manager(dir.path(), 1 << 30);
        let key = "srv:gone:raw";
        let loc = http_location(server.url("/gone"), key);
        let message = match mgr.open(&loc, 0) {
            Err(SourceError::Server(message)) => message,
            Err(other) => panic!("{content_type}: {other:?}"),
            Ok(mut opened) => {
                let mut buf = [0u8; 16];
                let error = opened.source.read(&mut buf).expect_err(content_type);
                match error
                    .get_ref()
                    .and_then(|e| e.downcast_ref::<SourceError>())
                {
                    Some(SourceError::Server(message)) => message.clone(),
                    other => panic!("{content_type}: {other:?}"),
                }
            }
        };
        assert_eq!(message, "data not found (code 70)", "{content_type}");
        assert!(!mgr.is_available_offline(&loc), "{content_type}");
        assert!(!events.completed(key), "{content_type}");
    }
}

/// Older versions cached such error documents as complete audio. They are dropped and fetched again.
#[test]
fn a_cached_error_document_is_discarded() {
    let data = test_data(MB, 22);
    let server = TestServer::start(data.clone(), ServerConfig::default());
    let dir = tempfile::tempdir().unwrap();
    let key = "srv:poisoned:raw";
    let hash = hash_hex(key);
    std::fs::write(dir.path().join(format!("{hash}.data")), GONE).unwrap();
    std::fs::write(
        dir.path().join(format!("{hash}.meta")),
        format!(
            "musify-cache 1\ntotal {n}\nseekable 1\ncomplete 1\naccess 5\nranges 0-{n}\nend\n",
            n = GONE.len()
        ),
    )
    .unwrap();
    let (mgr, events) = manager(dir.path(), 1 << 30);
    let loc = http_location(server.url("/poisoned"), key);
    assert!(
        mgr.is_available_offline(&loc),
        "the old entry counts as complete"
    );

    let mut src = mgr.open(&loc, 0).unwrap().source;
    assert!(read_all(src.as_mut()) == data);
    events.wait_completed(key);
    assert!(server.requests() > 0);
    assert!(mgr.is_available_offline(&loc));
}

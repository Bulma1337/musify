//! Byte sources for the decoder: local files and HTTP streams with a persistent range cache.
//!
//! Contract:
//! - HTTP sources download into a sparse cache file keyed by `sha256(cache_key)`, never by URL
//!   (URLs contain credentials and must never be logged).
//! - `read` blocks only the calling decoder thread while data is missing; waits > 150 ms emit
//!   `SourceEvent::Buffering`.
//! - Seeking beyond downloaded data issues a new `Range` request. Servers that answer `200` instead of
//!   `206` (typical for transcodes) produce a non-seekable source; `open(location, start_ms)` then
//!   restarts the stream with the location's `time_offset` parameter.
//! - Fully downloaded entries are marked complete; the cache is LRU-evicted to `max_bytes`, never
//!   evicting entries that are currently open.
//! - Error documents are never cached: Subsonic servers answer errors (e.g. a track that is gone)
//!   with 200 and a JSON/XML body, which fails with `SourceError::Server` (see `error_document.rs`).
//!
//! Implementation notes:
//! - Cache entry `<dir>/<sha256(cache_key)>.data` (sparse data, written at absolute offsets) plus
//!   `<hash>.meta` (see `meta.rs`): total length, seekable flag, downloaded ranges, complete flag,
//!   last access. Metadata is written atomically (tmp + rename); invalid or half-written metadata
//!   invalidates the entry (cleaned up at startup).
//! - One download thread per open entry (shared by all readers of that key). Prefetches run one at a
//!   time and yield while any reader is buffering.
//! - Time-offset restarts are streamed into a temporary, never-persisted `<sha256(key#t=ms)>.stream`
//!   file that is deleted when the last reader closes; the main cache entry is untouched.
//! - Download failures surface from `read` as `io::Error` wrapping a [`SourceError`]
//!   (`err.get_ref()?.downcast_ref::<SourceError>()`).

mod cache;
mod client;
mod download;
mod error_document;
mod http;
mod local;
mod meta;
mod range_set;

use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;

use crate::api::SourceLocation;

/// The blocking HTTP client and response types used by download threads (re-exported so that the app
/// shares one TLS stack and one reqwest version with the engine).
pub use reqwest::blocking::{Client as BlockingClient, Response as BlockingResponse};

pub use client::{
    build_http_client, describe_io, describe_reqwest, redact, time_offset_value,
    url_with_time_offset,
};

pub use error_document::{
    file_is_document, is_document_type, looks_like_document, read_server_message, server_message,
};

use cache::{Holder, Inner, RequestSpec};
use client::hash_key;
use http::{CachedHttpSource, EntryRef};
use local::FileSource;

/// A readable, optionally seekable byte stream handed to the decoder.
pub trait ByteSource: Read + Seek + Send + Sync {
    /// Total length in bytes, if known.
    fn byte_len(&self) -> Option<u64>;
    /// Whether byte-level seeking works.
    fn is_seekable(&self) -> bool;
}

#[derive(Clone, Debug)]
pub struct CacheConfig {
    pub dir: PathBuf,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SourceEvent {
    Buffering {
        cache_key: String,
        active: bool,
    },
    /// An entry was fully downloaded (e.g. to trigger loudness analysis).
    Completed {
        cache_key: String,
        path: PathBuf,
    },
}

pub type SourceEventSink = Arc<dyn Fn(SourceEvent) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("network error: {0}")]
    Network(String),
    #[error("HTTP status {0}")]
    Http(u16),
    /// The server answered with an error document instead of audio (e.g. the track is gone).
    #[error("server error: {0}")]
    Server(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cancelled")]
    Cancelled,
}

/// A source opened for decoding.
pub struct OpenedSource {
    pub source: Box<dyn ByteSource>,
    /// Position (ms) the stream starts at. Non-zero when a transcode was restarted with a time
    /// offset; the decoder then treats its timestamp 0 as this position.
    pub starts_at_ms: u64,
}

/// How long `open` waits for the server's response headers (after retries) before giving up.
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub struct SourceManager {
    config: CacheConfig,
    inner: Arc<Inner>,
}

impl SourceManager {
    pub fn new(cache: CacheConfig, events: SourceEventSink) -> Self {
        let inner = Inner::new(cache.dir.clone(), cache.max_bytes, events);
        Self {
            config: cache,
            inner,
        }
    }

    /// Opens a location. `start_ms` matters only for non-seekable transcodes (time-offset restart);
    /// seekable sources start at byte 0 and the decoder seeks.
    ///
    /// A transcoded location with a `time_offset` that is not completely cached is restarted at
    /// `start_ms` (seconds are truncated; `starts_at_ms` reports the effective position).
    pub fn open(
        &self,
        location: &SourceLocation,
        start_ms: u64,
    ) -> Result<OpenedSource, SourceError> {
        match location {
            SourceLocation::Local { path } => Ok(OpenedSource {
                source: Box::new(FileSource::open(path)?),
                starts_at_ms: 0,
            }),
            SourceLocation::Http {
                url,
                headers,
                cache_key,
                transcoded,
                time_offset,
                allow_insecure_tls,
                ..
            } => {
                let hash = hash_key(cache_key);
                let spec = RequestSpec {
                    url: url.clone(),
                    headers: headers.clone(),
                    insecure: *allow_insecure_tls,
                };
                if start_ms > 0
                    && *transcoded
                    && let Some(param) = time_offset
                    && !self.inner.is_complete(&hash)
                {
                    let (offset_url, effective_ms) = url_with_time_offset(url, param, start_ms)
                        .ok_or_else(|| {
                            SourceError::Network(format!("invalid stream URL for {cache_key}"))
                        })?;
                    // Separate, temporary file (never persisted); events keep the real cache key.
                    let offset_hash = hash_key(&format!("{cache_key}#t={effective_ms}"));
                    let spec = RequestSpec {
                        url: offset_url,
                        ..spec
                    };
                    let source = self.open_http(cache_key, &offset_hash, spec, true)?;
                    return Ok(OpenedSource {
                        source,
                        starts_at_ms: effective_ms,
                    });
                }
                let source = self.open_http(cache_key, &hash, spec, false)?;
                Ok(OpenedSource {
                    source,
                    starts_at_ms: 0,
                })
            }
        }
    }

    fn open_http(
        &self,
        key: &str,
        hash: &str,
        spec: RequestSpec,
        ephemeral: bool,
    ) -> Result<Box<dyn ByteSource>, SourceError> {
        let entry = self
            .inner
            .acquire(key, hash, spec, ephemeral, Holder::Reader)?;
        let r = EntryRef {
            inner: self.inner.clone(),
            entry,
        };
        let entry = r.entry.clone();
        if entry.state.lock().complete && !self.inner.discard_document(&entry) {
            // Offline / fully cached: plain buffered file, no network.
            let file = FileSource::open(&entry.data_path)?;
            return Ok(Box::new(file.with_guard(Box::new(r))));
        }
        // Start the download and wait for the response headers so that `is_seekable` and
        // `byte_len` are known when the decoder probes.
        let deadline = std::time::Instant::now() + OPEN_TIMEOUT;
        let mut st = entry.state.lock();
        self.inner.spawn_downloader(&entry, &mut st);
        while !st.complete && st.seekable.is_none() {
            if let Some(err) = st.error.clone() {
                drop(st);
                return Err(err.to_source_error());
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(SourceError::Network(format!(
                    "timed out waiting for the server ({key})"
                )));
            }
            entry.cond.wait_for(
                &mut st,
                (deadline - now).min(std::time::Duration::from_millis(200)),
            );
        }
        drop(st);
        Ok(Box::new(CachedHttpSource::new(r)?))
    }

    /// Starts downloading a location into the cache in the background (next track).
    pub fn prefetch(&self, location: &SourceLocation) {
        let SourceLocation::Http {
            url,
            headers,
            cache_key,
            allow_insecure_tls,
            ..
        } = location
        else {
            return;
        };
        let hash = hash_key(cache_key);
        if self.inner.is_complete(&hash) {
            return;
        }
        let spec = RequestSpec {
            url: url.clone(),
            headers: headers.clone(),
            insecure: *allow_insecure_tls,
        };
        self.inner.enqueue_prefetch(cache_key, hash, spec);
    }

    /// Stops a background download started by `prefetch` (the partial data stays cached).
    pub fn cancel_prefetch(&self, cache_key: &str) {
        self.inner.cancel_prefetch(&hash_key(cache_key));
    }

    /// True when the location is a local file or a complete cache entry (plays without network).
    pub fn is_available_offline(&self, location: &SourceLocation) -> bool {
        match location {
            SourceLocation::Local { path } => path.is_file(),
            SourceLocation::Http { cache_key, .. } => self.inner.is_complete(&hash_key(cache_key)),
        }
    }

    pub fn set_cache_limit(&self, max_bytes: u64) {
        self.inner.set_limit(max_bytes);
    }

    /// Bytes currently used by the cache.
    pub fn cache_size(&self) -> u64 {
        self.inner.cache_size()
    }

    /// Deletes all cache entries that are not currently open.
    pub fn clear_cache(&self) -> std::io::Result<()> {
        self.inner.clear()
    }

    /// The cache directory this manager was created with.
    pub fn cache_dir(&self) -> &std::path::Path {
        &self.config.dir
    }
}

impl Drop for SourceManager {
    /// Background prefetches stop with the manager; open sources keep working until dropped.
    fn drop(&mut self) {
        self.inner.cancel_all_prefetches();
    }
}

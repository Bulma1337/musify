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

use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;

use crate::api::SourceLocation;

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
    Buffering { cache_key: String, active: bool },
    /// An entry was fully downloaded (e.g. to trigger loudness analysis).
    Completed { cache_key: String, path: PathBuf },
}

pub type SourceEventSink = Arc<dyn Fn(SourceEvent) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("network error: {0}")]
    Network(String),
    #[error("HTTP status {0}")]
    Http(u16),
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

pub struct SourceManager {
    config: CacheConfig,
}

impl SourceManager {
    pub fn new(cache: CacheConfig, events: SourceEventSink) -> Self {
        let _ = (cache, events);
        todo!("source: SourceManager::new")
    }

    /// Opens a location. `start_ms` matters only for non-seekable transcodes (time-offset restart);
    /// seekable sources start at byte 0 and the decoder seeks.
    pub fn open(&self, location: &SourceLocation, start_ms: u64) -> Result<OpenedSource, SourceError> {
        let _ = (location, start_ms);
        todo!("source: open")
    }

    /// Starts downloading a location into the cache in the background (next track).
    pub fn prefetch(&self, location: &SourceLocation) {
        let _ = location;
        todo!("source: prefetch")
    }

    /// Stops a background download started by `prefetch` (the partial data stays cached).
    pub fn cancel_prefetch(&self, cache_key: &str) {
        let _ = cache_key;
        todo!("source: cancel_prefetch")
    }

    /// True when the location is a local file or a complete cache entry (plays without network).
    pub fn is_available_offline(&self, location: &SourceLocation) -> bool {
        let _ = location;
        todo!("source: is_available_offline")
    }

    pub fn set_cache_limit(&self, max_bytes: u64) {
        let _ = max_bytes;
        todo!("source: set_cache_limit")
    }

    /// Bytes currently used by the cache.
    pub fn cache_size(&self) -> u64 {
        todo!("source: cache_size")
    }

    /// Deletes all cache entries that are not currently open.
    pub fn clear_cache(&self) -> std::io::Result<()> {
        todo!("source: clear_cache")
    }
}

//! Persistent HTTP range cache: open-entry registry (reference counted), on-disk index, LRU
//! eviction and the prefetch queue.
//!
//! Lock order (never acquire in the opposite direction):
//! `prefetch` → `active` → `Entry::meta_lock` → `Entry::state` / `index`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::{Condvar, Mutex};
use reqwest::blocking::Client;

use super::client::build_http_client;
use super::download::Downloader;
use super::meta::Meta;
use super::range_set::RangeSet;
use super::{SourceError, SourceEvent, SourceEventSink};

/// Everything needed to (re)issue the HTTP request of an entry. Never logged.
#[derive(Clone)]
pub(crate) struct RequestSpec {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub insecure: bool,
}

/// Terminal download failure (after retries), surfaced to readers.
#[derive(Clone, Debug)]
pub(crate) enum FetchError {
    Http(u16),
    /// Error document instead of audio, with the server's message.
    Server(String),
    Network(String),
    Io(String),
}

impl FetchError {
    pub(crate) fn to_source_error(&self) -> SourceError {
        match self {
            FetchError::Http(code) => SourceError::Http(*code),
            FetchError::Server(m) => SourceError::Server(m.clone()),
            FetchError::Network(m) => SourceError::Network(m.clone()),
            FetchError::Io(m) => SourceError::Io(io::Error::other(m.clone())),
        }
    }

    /// I/O error for `Read::read`; wraps a [`SourceError`] so callers can downcast and classify it.
    pub(crate) fn to_io_error(&self) -> io::Error {
        io::Error::other(self.to_source_error())
    }

    pub(crate) fn message(&self) -> String {
        match self {
            FetchError::Http(code) => format!("HTTP status {code}"),
            FetchError::Server(m) | FetchError::Network(m) | FetchError::Io(m) => m.clone(),
        }
    }
}

pub(crate) struct EntryState {
    pub ranges: RangeSet,
    pub total_len: Option<u64>,
    /// `Some(true)` once the server answered 206, `Some(false)` for 200 (forward-only stream).
    pub seekable: Option<bool>,
    pub complete: bool,
    pub last_access: u64,
    pub readers: usize,
    pub prefetching: bool,
    pub downloader_running: bool,
    /// Next byte the active response will deliver (None between requests).
    pub dl_pos: Option<u64>,
    /// Position the readers need next (set on a read miss).
    pub want_pos: u64,
    /// Bumped whenever readers change `want_pos` or acknowledge an error.
    pub generation: u64,
    pub error: Option<FetchError>,
}

impl EntryState {
    pub(crate) fn users(&self) -> usize {
        self.readers + usize::from(self.prefetching)
    }

    /// Marks the entry complete when every byte is present. Returns true if it just became complete.
    pub(crate) fn mark_complete_if_full(&mut self) -> bool {
        if self.complete {
            return false;
        }
        match self.total_len {
            Some(t) if self.ranges.covers(0, t) => {
                self.complete = true;
                self.error = None;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn is_seekable(&self) -> bool {
        self.complete || self.seekable == Some(true)
    }
}

pub(crate) struct Entry {
    /// The credential-free cache key: the only identifier used in logs and events.
    pub key: String,
    pub hash: String,
    pub data_path: PathBuf,
    /// `None` for ephemeral (time-offset) streams, which are never persisted.
    pub meta_path: Option<PathBuf>,
    pub request: Mutex<RequestSpec>,
    pub state: Mutex<EntryState>,
    pub cond: Condvar,
    meta_lock: Mutex<()>,
}

impl Entry {
    pub(crate) fn is_ephemeral(&self) -> bool {
        self.meta_path.is_none()
    }
}

#[derive(Clone, Copy, Debug)]
struct IndexRec {
    size: u64,
    last_access: u64,
    complete: bool,
}

struct PrefetchJob {
    key: String,
    hash: String,
    spec: RequestSpec,
}

#[derive(Default)]
struct PrefetchQueue {
    active: Option<String>,
    queue: VecDeque<PrefetchJob>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Holder {
    Reader,
    Prefetch,
}

pub(crate) struct Inner {
    pub dir: PathBuf,
    max_bytes: AtomicU64,
    events: SourceEventSink,
    clients: [OnceLock<Result<Client, String>>; 2],
    active: Mutex<HashMap<String, Arc<Entry>>>,
    index: Mutex<HashMap<String, IndexRec>>,
    prefetch: Mutex<PrefetchQueue>,
    /// Readers currently stalled (> 150 ms) on missing data; prefetch downloads yield meanwhile.
    pub buffering_readers: AtomicUsize,
}

/// Strictly increasing wall-clock milliseconds (LRU order must be total even within one ms).
pub(crate) fn now_access() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut prev = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(prev + 1);
        match LAST.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(p) => prev = p,
        }
    }
}

fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

impl Inner {
    pub(crate) fn new(dir: PathBuf, max_bytes: u64, events: SourceEventSink) -> Arc<Self> {
        let inner = Arc::new(Self {
            dir,
            max_bytes: AtomicU64::new(max_bytes),
            events,
            clients: [OnceLock::new(), OnceLock::new()],
            active: Mutex::new(HashMap::new()),
            index: Mutex::new(HashMap::new()),
            prefetch: Mutex::new(PrefetchQueue::default()),
            buffering_readers: AtomicUsize::new(0),
        });
        let index = scan_dir(&inner.dir);
        *inner.index.lock() = index;
        inner.enforce_limit();
        inner
    }

    pub(crate) fn emit(&self, event: SourceEvent) {
        (self.events)(event);
    }

    pub(crate) fn client(&self, insecure: bool) -> Result<Client, String> {
        self.clients[usize::from(insecure)]
            .get_or_init(|| build_http_client(insecure).map_err(|e| e.to_string()))
            .clone()
    }

    fn data_path(&self, hash: &str, ephemeral: bool) -> PathBuf {
        self.dir.join(format!(
            "{hash}.{}",
            if ephemeral { "stream" } else { "data" }
        ))
    }

    fn meta_path(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.meta"))
    }

    /// Returns the shared entry for `hash`, creating it (from disk metadata) if no one has it open,
    /// and registers `holder` as a user.
    pub(crate) fn acquire(
        self: &Arc<Self>,
        key: &str,
        hash: &str,
        spec: RequestSpec,
        ephemeral: bool,
        holder: Holder,
    ) -> io::Result<Arc<Entry>> {
        let mut active = self.active.lock();
        if let Some(entry) = active.get(hash) {
            *entry.request.lock() = spec;
            let mut st = entry.state.lock();
            match holder {
                Holder::Reader => st.readers += 1,
                Holder::Prefetch => st.prefetching = true,
            }
            st.last_access = now_access();
            if st.error.take().is_some() {
                // A new user retries a failed download (the parked download thread resumes).
                st.generation += 1;
                drop(st);
                entry.cond.notify_all();
            }
            return Ok(entry.clone());
        }

        fs::create_dir_all(&self.dir)?;
        let data_path = self.data_path(hash, ephemeral);
        let meta_path = (!ephemeral).then(|| self.meta_path(hash));
        let data_len = fs::metadata(&data_path).ok().map(|m| m.len());
        let loaded = meta_path
            .as_deref()
            .and_then(Meta::load)
            .filter(|_| data_len.is_some());
        let valid = loaded.is_some();
        let mut meta = loaded.unwrap_or_default();
        if !meta.complete && meta.seekable == Some(false) {
            // A partial forward-only (transcoded) stream restarts from byte 0; a new transcode is
            // not guaranteed to be byte-identical, so the old prefix is dropped.
            meta = Meta {
                last_access: meta.last_access,
                ..Meta::default()
            };
        }
        if let Some(len) = data_len {
            meta.ranges.truncate(len);
            if meta.complete && meta.total_len != Some(len) {
                meta.complete = false;
            }
        }
        if !valid || meta.ranges.is_empty() {
            // Fresh (or untrustworthy) entry: start from an empty data file.
            fs::File::create(&data_path)?;
            meta.ranges.clear();
            meta.complete = false;
        } else {
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&data_path)?;
        }

        let last_access = now_access();
        let complete = meta.complete;
        let entry = Arc::new(Entry {
            key: key.to_owned(),
            hash: hash.to_owned(),
            data_path,
            meta_path,
            request: Mutex::new(spec),
            state: Mutex::new(EntryState {
                ranges: meta.ranges,
                total_len: meta.total_len,
                seekable: meta.seekable,
                complete,
                last_access,
                readers: usize::from(holder == Holder::Reader),
                prefetching: holder == Holder::Prefetch,
                downloader_running: false,
                dl_pos: None,
                want_pos: 0,
                generation: 0,
                error: None,
            }),
            cond: Condvar::new(),
            meta_lock: Mutex::new(()),
        });
        if !ephemeral {
            let size = fs::metadata(&entry.data_path).map(|m| m.len()).unwrap_or(0);
            self.index.lock().insert(
                hash.to_owned(),
                IndexRec {
                    size,
                    last_access,
                    complete,
                },
            );
        }
        active.insert(hash.to_owned(), entry.clone());
        Ok(entry)
    }

    /// Drops one user of `entry`; the entry leaves the registry when nobody uses it and its
    /// download thread has stopped.
    pub(crate) fn release(self: &Arc<Self>, entry: &Arc<Entry>, holder: Holder) {
        let removed = {
            let mut active = self.active.lock();
            {
                let mut st = entry.state.lock();
                match holder {
                    Holder::Reader => st.readers = st.readers.saturating_sub(1),
                    Holder::Prefetch => st.prefetching = false,
                }
                st.last_access = now_access();
            }
            entry.cond.notify_all();
            self.save_meta(entry);
            self.retire_if_unused(&mut active, entry)
        };
        if removed {
            self.enforce_limit();
        }
    }

    /// Called by a download thread that wants to stop. Returns false when it must keep running
    /// (a user arrived meanwhile). Returns `(stopped, prefetch_ended, removed)`.
    pub(crate) fn downloader_try_stop(self: &Arc<Self>, entry: &Arc<Entry>) -> (bool, bool, bool) {
        let mut active = self.active.lock();
        let prefetch_ended;
        {
            let mut st = entry.state.lock();
            let failed_without_readers = st.error.is_some() && st.readers == 0;
            if st.users() > 0 && !st.complete && !failed_without_readers {
                return (false, false, false);
            }
            st.downloader_running = false;
            st.dl_pos = None;
            prefetch_ended = st.prefetching;
            st.prefetching = false;
        }
        entry.cond.notify_all();
        self.save_meta(entry);
        let removed = self.retire_if_unused(&mut active, entry);
        (true, prefetch_ended, removed)
    }

    fn retire_if_unused(
        &self,
        active: &mut HashMap<String, Arc<Entry>>,
        entry: &Arc<Entry>,
    ) -> bool {
        let unused = {
            let st = entry.state.lock();
            st.users() == 0 && !st.downloader_running
        };
        if !unused
            || !active
                .get(&entry.hash)
                .is_some_and(|e| Arc::ptr_eq(e, entry))
        {
            return false;
        }
        active.remove(&entry.hash);
        if entry.is_ephemeral()
            && let Err(e) = remove_if_exists(&entry.data_path)
        {
            log::warn!(
                "source {}: could not delete temporary stream file: {e}",
                entry.key
            );
        }
        true
    }

    pub(crate) fn spawn_downloader(self: &Arc<Self>, entry: &Arc<Entry>, st: &mut EntryState) {
        if st.downloader_running || st.complete {
            return;
        }
        st.downloader_running = true;
        let downloader = Downloader::new(self.clone(), entry.clone());
        let spawned = thread::Builder::new()
            .name("musify-source-dl".into())
            .spawn(move || downloader.run());
        if let Err(e) = spawned {
            st.downloader_running = false;
            st.error = Some(FetchError::Io(format!(
                "could not start download thread: {e}"
            )));
        }
    }

    /// Persists the entry metadata (atomic) and refreshes the index. Ephemeral entries: no-op.
    pub(crate) fn save_meta(&self, entry: &Entry) {
        let Some(meta_path) = entry.meta_path.as_deref() else {
            return;
        };
        let _guard = entry.meta_lock.lock();
        let meta = {
            let st = entry.state.lock();
            Meta {
                total_len: st.total_len,
                seekable: st.seekable,
                complete: st.complete,
                last_access: st.last_access,
                ranges: st.ranges.clone(),
            }
        };
        if let Err(e) = meta.store(meta_path) {
            log::warn!("source {}: could not write cache metadata: {e}", entry.key);
        }
        let size = fs::metadata(&entry.data_path).map(|m| m.len()).unwrap_or(0);
        self.index.lock().insert(
            entry.hash.clone(),
            IndexRec {
                size,
                last_access: meta.last_access,
                complete: meta.complete,
            },
        );
    }

    pub(crate) fn on_completed(&self, entry: &Entry) {
        self.save_meta(entry);
        self.enforce_limit();
        if !entry.is_ephemeral() {
            log::debug!("source {}: cache entry complete", entry.key);
            self.emit(SourceEvent::Completed {
                cache_key: entry.key.clone(),
                path: entry.data_path.clone(),
            });
        }
    }

    /// A complete entry whose data is a server error document (older versions cached those as
    /// audio): forgets the data so that the next request asks the server again. Returns true if
    /// the entry was discarded.
    pub(crate) fn discard_document(&self, entry: &Entry) -> bool {
        {
            let mut st = entry.state.lock();
            if !st.complete || !super::file_is_document(&entry.data_path) {
                return false;
            }
            st.complete = false;
            st.ranges.clear();
            st.total_len = None;
            st.seekable = None;
            st.error = None;
        }
        if let Ok(file) = OpenOptions::new().write(true).open(&entry.data_path) {
            let _ = file.set_len(0);
        }
        self.save_meta(entry);
        log::warn!(
            "source {}: cached data was a server error, not audio; discarded",
            entry.key
        );
        true
    }

    pub(crate) fn is_complete(&self, hash: &str) -> bool {
        if let Some(entry) = self.active.lock().get(hash) {
            return entry.state.lock().complete;
        }
        self.index.lock().get(hash).is_some_and(|r| r.complete)
    }

    pub(crate) fn set_limit(&self, max_bytes: u64) {
        self.max_bytes.store(max_bytes, Ordering::Relaxed);
        self.enforce_limit();
    }

    pub(crate) fn cache_size(&self) -> u64 {
        self.index.lock().values().map(|r| r.size).sum()
    }

    /// Evicts least recently used entries that nobody has open until the cache fits `max_bytes`.
    pub(crate) fn enforce_limit(&self) {
        let active = self.active.lock();
        let mut index = self.index.lock();
        let max = self.max_bytes.load(Ordering::Relaxed);
        let mut total: u64 = index.values().map(|r| r.size).sum();
        if total <= max {
            return;
        }
        let mut candidates: Vec<(u64, String, u64)> = index
            .iter()
            .filter(|(h, _)| !active.contains_key(*h))
            .map(|(h, r)| (r.last_access, h.clone(), r.size))
            .collect();
        candidates.sort();
        for (_, hash, size) in candidates {
            if total <= max {
                break;
            }
            let data = self.data_path(&hash, false);
            let meta = self.meta_path(&hash);
            // Metadata first: a data file without metadata is cleaned up at the next start.
            let res = remove_if_exists(&meta).and_then(|_| remove_if_exists(&data));
            match res {
                Ok(()) => {
                    index.remove(&hash);
                    total = total.saturating_sub(size);
                }
                Err(e) => log::warn!("source cache: could not evict entry {hash}: {e}"),
            }
        }
    }

    /// Deletes every cache file whose entry is not currently open.
    pub(crate) fn clear(&self) -> io::Result<()> {
        let active = self.active.lock();
        let mut index = self.index.lock();
        index.retain(|h, _| active.contains_key(h));
        let read_dir = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let mut first_err = None;
        for item in read_dir.flatten() {
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some((stem, ext)) = name.split_once('.') else {
                continue;
            };
            if !is_hash(stem)
                || !matches!(ext, "data" | "meta" | "meta.tmp" | "stream")
                || active.contains_key(stem)
            {
                continue;
            }
            if let Err(e) = remove_if_exists(&item.path()) {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    // --- prefetch -------------------------------------------------------------------------------

    pub(crate) fn enqueue_prefetch(self: &Arc<Self>, key: &str, hash: String, spec: RequestSpec) {
        let mut pq = self.prefetch.lock();
        if pq.active.as_deref() == Some(hash.as_str()) || pq.queue.iter().any(|j| j.hash == hash) {
            return;
        }
        pq.queue.push_back(PrefetchJob {
            key: key.to_owned(),
            hash,
            spec,
        });
        self.pump_prefetch(&mut pq);
    }

    /// Cancels every queued and running prefetch (manager shutdown).
    pub(crate) fn cancel_all_prefetches(self: &Arc<Self>) {
        let active = {
            let mut pq = self.prefetch.lock();
            pq.queue.clear();
            pq.active.take()
        };
        if let Some(hash) = active {
            let entry = self.active.lock().get(&hash).cloned();
            if let Some(entry) = entry {
                self.release(&entry, Holder::Prefetch);
            }
        }
    }

    pub(crate) fn cancel_prefetch(self: &Arc<Self>, hash: &str) {
        let mut pq = self.prefetch.lock();
        pq.queue.retain(|j| j.hash != hash);
        if pq.active.as_deref() == Some(hash) {
            pq.active = None;
            let entry = self.active.lock().get(hash).cloned();
            if let Some(entry) = entry {
                self.release(&entry, Holder::Prefetch);
            }
            self.pump_prefetch(&mut pq);
        }
    }

    pub(crate) fn prefetch_finished(self: &Arc<Self>, hash: &str) {
        let mut pq = self.prefetch.lock();
        if pq.active.as_deref() == Some(hash) {
            pq.active = None;
            self.pump_prefetch(&mut pq);
        }
    }

    /// Starts queued prefetches, one at a time.
    fn pump_prefetch(self: &Arc<Self>, pq: &mut PrefetchQueue) {
        while pq.active.is_none() {
            let Some(job) = pq.queue.pop_front() else {
                break;
            };
            if self.is_complete(&job.hash) {
                continue;
            }
            match self.acquire(&job.key, &job.hash, job.spec, false, Holder::Prefetch) {
                Ok(entry) => {
                    let started = {
                        let mut st = entry.state.lock();
                        self.spawn_downloader(&entry, &mut st);
                        st.downloader_running
                    };
                    if started {
                        log::debug!("source {}: prefetch started", job.key);
                        pq.active = Some(job.hash);
                    } else {
                        self.release(&entry, Holder::Prefetch);
                    }
                }
                Err(e) => log::warn!("source {}: prefetch failed: {e}", job.key),
            }
        }
    }
}

/// Builds the index from disk and removes debris: half-written or invalid metadata, data files
/// without metadata, temporary files and leftover time-offset streams.
fn scan_dir(dir: &Path) -> HashMap<String, IndexRec> {
    let mut index = HashMap::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return index;
    };
    let mut metas = Vec::new();
    let mut datas = HashSet::new();
    for item in read_dir.flatten() {
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((stem, ext)) = name.split_once('.') else {
            continue;
        };
        if !is_hash(stem) {
            continue;
        }
        match ext {
            "meta" => metas.push(stem.to_owned()),
            "data" => {
                datas.insert(stem.to_owned());
            }
            "meta.tmp" | "stream" => {
                let _ = remove_if_exists(&item.path());
            }
            _ => {}
        }
    }
    for hash in metas {
        let meta_path = dir.join(format!("{hash}.meta"));
        let data_path = dir.join(format!("{hash}.data"));
        let data_len = fs::metadata(&data_path).ok().map(|m| m.len());
        match (Meta::load(&meta_path), data_len) {
            (Some(meta), Some(len)) => {
                datas.remove(&hash);
                let complete = meta.complete && meta.total_len == Some(len);
                index.insert(
                    hash,
                    IndexRec {
                        size: len,
                        last_access: meta.last_access,
                        complete,
                    },
                );
            }
            _ => {
                log::debug!("source cache: removing invalid entry {hash}");
                let _ = remove_if_exists(&meta_path);
                let _ = remove_if_exists(&data_path);
                datas.remove(&hash);
            }
        }
    }
    for hash in datas {
        let _ = remove_if_exists(&dir.join(format!("{hash}.data")));
    }
    index
}

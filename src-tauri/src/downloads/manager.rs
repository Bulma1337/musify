//! The download manager: a queue of jobs worked off by a few threads, with resume, retries,
//! cancellation, throttled progress events and the bookkeeping in the database.
//!
//! Threads: `PARALLEL` workers (blocking HTTP, which is fine off the async runtime) plus one ticker
//! that flushes progress updates ten times per second. Nothing here runs on the main thread or in
//! the audio engine.
//!
//! Lock order: a job's `phase` → `queue`. The `queue` lock is never held while taking a `phase`.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use musify_audio::source::{BlockingClient, build_http_client};
use serde::{Deserialize, Serialize};

use super::paths::{self, PARTIAL_DIR, TrackLayout};
use super::store::{
    self, CollectionInput, CollectionRow, QueuedTrack, STATE_DONE, STATE_DOWNLOADING, STATE_FAILED,
    STATE_QUEUED, TrackKey, TrackRow,
};
use super::transfer::{self, Source, TransferError};
use crate::db::Db;

/// Simultaneous downloads.
pub const PARALLEL: usize = 3;
/// Progress updates are sent in batches at this interval (≈ 10 per second overall).
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const COVER_LIMIT: u64 = 15 * 1024 * 1024;

/// State of one download as sent to the frontend. `removed` means the row is gone.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUpdate {
    pub server_id: String,
    pub track_id: String,
    /// queued | downloading | done | failed | removed
    pub state: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub error: Option<String>,
    /// Absolute path of the finished file.
    pub path: Option<String>,
    pub size_bytes: u64,
}

impl DownloadUpdate {
    fn new(key: &TrackKey, state: &str) -> Self {
        Self {
            server_id: key.server_id.clone(),
            track_id: key.track_id.clone(),
            state: state.to_string(),
            bytes_done: 0,
            bytes_total: None,
            error: None,
            path: None,
            size_bytes: 0,
        }
    }
}

pub type Sink = Arc<dyn Fn(Vec<DownloadUpdate>) + Send + Sync>;

/// Cover image to save next to an album's tracks.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverJob {
    pub cover_ref: String,
    pub source: Source,
}

/// One track to download. Source URL and headers live in memory only.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueJob {
    pub server_id: String,
    pub track_id: String,
    /// Quality preset name ("original", "high", …); part of the partial file's identity.
    pub quality: String,
    /// Track snapshot (JSON) stored for offline browsing.
    pub track_json: String,
    #[serde(default)]
    pub individual: bool,
    pub source: Source,
    #[serde(default)]
    pub layout: TrackLayout,
    /// Container/format the frontend expects ("flac", "opus", …); decides the file extension.
    pub container: Option<String>,
    pub cover: Option<CoverJob>,
}

impl EnqueueJob {
    fn key(&self) -> TrackKey {
        TrackKey::new(&self.server_id, &self.track_id)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(20),
        }
    }
}

impl RetryPolicy {
    /// Delay before attempt `attempt + 1` (attempt counts from 1): 1 s, 2 s, 4 s …
    pub fn delay(&self, attempt: u32) -> Duration {
        let factor = 1u32 << attempt.saturating_sub(1).min(16);
        (self.base_delay * factor).min(self.max_delay)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Queued,
    Running,
    Finalizing,
    Finished,
    Cancelled,
}

struct Job {
    key: TrackKey,
    req: EnqueueJob,
    phase: Mutex<Phase>,
    cancel: AtomicBool,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Arc<Job>>,
    jobs: HashMap<TrackKey, Arc<Job>>,
    shutdown: bool,
    moving: bool,
}

#[derive(Default)]
struct Reporter {
    pending: Mutex<HashMap<TrackKey, DownloadUpdate>>,
    sink: Mutex<Option<Sink>>,
}

impl Reporter {
    fn push(&self, key: &TrackKey, update: DownloadUpdate) {
        lock(&self.pending).insert(key.clone(), update);
    }

    fn flush(&self) {
        let batch: Vec<DownloadUpdate> = {
            let mut pending = lock(&self.pending);
            if pending.is_empty() {
                return;
            }
            pending.drain().map(|(_, u)| u).collect()
        };
        let sink = lock(&self.sink).clone();
        if let Some(sink) = sink {
            sink(batch);
        }
    }
}

/// Recovers a poisoned mutex: the data (queues, maps) stays consistent across a panicking worker.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Inner {
    db: Arc<Db>,
    dir: RwLock<PathBuf>,
    queue: Mutex<Queue>,
    cond: Condvar,
    reporter: Reporter,
    retry: RetryPolicy,
    clients: Mutex<[Option<BlockingClient>; 2]>,
    /// Serializes choosing a free file name and moving the file there.
    finalize_lock: Mutex<()>,
    /// Serializes saving cover images (several tracks of one album finish at about the same time).
    cover_lock: Mutex<()>,
}

pub struct Manager {
    inner: Arc<Inner>,
}

impl Manager {
    /// Creates the manager and starts its threads. Rows left `downloading` by a crash are queued again
    /// (the frontend hands their sources over once it is up).
    pub fn new(db: Arc<Db>, dir: PathBuf, retry: RetryPolicy) -> Self {
        if let Err(e) = db.with(|c| store::reset_interrupted(c)) {
            log::warn!("cannot reset interrupted downloads: {e}");
        }
        let inner = Arc::new(Inner {
            db,
            dir: RwLock::new(dir),
            queue: Mutex::new(Queue::default()),
            cond: Condvar::new(),
            reporter: Reporter::default(),
            retry,
            clients: Mutex::new([None, None]),
            finalize_lock: Mutex::new(()),
            cover_lock: Mutex::new(()),
        });
        for n in 0..PARALLEL {
            let inner = Arc::clone(&inner);
            thread::Builder::new()
                .name(format!("musify-download-{n}"))
                .spawn(move || inner.worker())
                .expect("spawn download worker");
        }
        let weak = Arc::downgrade(&inner);
        thread::Builder::new()
            .name("musify-download-events".into())
            .spawn(move || ticker(weak))
            .expect("spawn download event ticker");
        Self { inner }
    }

    pub fn set_sink(&self, sink: Sink) {
        *lock(&self.inner.reporter.sink) = Some(sink);
    }

    pub fn dir(&self) -> PathBuf {
        self.inner.dir()
    }

    pub fn db(&self) -> &Arc<Db> {
        &self.inner.db
    }

    /// Queues tracks. Tracks that are already downloaded (and still on disk) or already queued are
    /// left alone; a failed or interrupted one is started again.
    pub fn enqueue(&self, jobs: Vec<EnqueueJob>) -> Result<(), String> {
        let inner = &self.inner;
        let dir = inner.dir();
        for req in jobs {
            let key = req.key();
            let existing = inner.db.with(|c| store::get_track(c, &key))?;
            if let Some(row) = &existing
                && row.state == STATE_DONE
                && row
                    .path
                    .as_deref()
                    .and_then(|p| paths::from_db_path(&dir, p))
                    .is_some_and(|p| p.is_file())
            {
                if req.individual && !row.individual {
                    inner.db.with(|c| store::set_individual(c, &key, true))?;
                }
                continue;
            }
            let mut queue = lock(&inner.queue);
            if queue.moving {
                return Err("the downloads folder is being moved".into());
            }
            if queue.jobs.contains_key(&key) {
                drop(queue);
                if req.individual {
                    inner.db.with(|c| store::set_individual(c, &key, true))?;
                }
                continue;
            }
            inner.db.with(|c| {
                store::upsert_queued(
                    c,
                    &QueuedTrack {
                        key: &key,
                        quality: &req.quality,
                        container: req.container.as_deref(),
                        track_json: &req.track_json,
                        individual: req.individual,
                    },
                )
            })?;
            let job = Arc::new(Job {
                key: key.clone(),
                req,
                phase: Mutex::new(Phase::Queued),
                cancel: AtomicBool::new(false),
            });
            queue.jobs.insert(key.clone(), Arc::clone(&job));
            queue.pending.push_back(job);
            drop(queue);
            inner
                .reporter
                .push(&key, DownloadUpdate::new(&key, STATE_QUEUED));
            inner.cond.notify_one();
        }
        Ok(())
    }

    /// Stops the given downloads and deletes their files and rows.
    pub fn remove_tracks(&self, keys: &[TrackKey]) -> Result<(), String> {
        if lock(&self.inner.queue).moving {
            return Err("the downloads folder is being moved".into());
        }
        for key in keys {
            self.inner.remove_track(key)?;
        }
        Ok(())
    }

    /// Drops the individual flag of a track and deletes it unless a collection still lists it.
    /// Returns true when the track was removed.
    pub fn remove_individual(&self, key: &TrackKey) -> Result<bool, String> {
        self.inner
            .db
            .with(|c| store::set_individual(c, key, false))?;
        let kept = self.inner.db.with(|c| store::in_any_collection(c, key))?;
        if kept {
            return Ok(false);
        }
        self.remove_tracks(std::slice::from_ref(key))?;
        Ok(true)
    }

    /// Registers (or updates) a collection, queues its tracks and deletes tracks that no collection
    /// lists any more.
    pub fn set_collection(
        &self,
        collection: CollectionInput,
        jobs: Vec<EnqueueJob>,
    ) -> Result<(), String> {
        let server_id = collection.server_id.clone();
        self.inner
            .db
            .with(|c| store::upsert_collection(c, &collection))?;
        self.enqueue(jobs)?;
        self.collect_garbage(&server_id)
    }

    pub fn remove_collection(
        &self,
        server_id: &str,
        kind: &str,
        item_id: &str,
    ) -> Result<(), String> {
        self.inner
            .db
            .with(|c| store::delete_collection(c, server_id, kind, item_id))?;
        self.collect_garbage(server_id)
    }

    /// Deletes tracks that are in no collection and were not downloaded individually.
    pub fn collect_garbage(&self, server_id: &str) -> Result<(), String> {
        let orphans = self
            .inner
            .db
            .with(|c| store::orphaned_tracks(c, server_id))?;
        let keys: Vec<TrackKey> = orphans
            .iter()
            .map(|r| TrackKey::new(&r.server_id, &r.track_id))
            .collect();
        self.remove_tracks(&keys)
    }

    /// Deletes every download and collection of every server.
    pub fn remove_all(&self) -> Result<(), String> {
        let inner = &self.inner;
        if lock(&inner.queue).moving {
            return Err("the downloads folder is being moved".into());
        }
        let rows = inner.db.with(|c| store::all_tracks(c))?;
        for row in &rows {
            inner.remove_track(&TrackKey::new(&row.server_id, &row.track_id))?;
        }
        // Collections and the covers saved next to the tracks.
        let covers = inner.db.with(|c| store::all_cover_paths(c))?;
        let dir = inner.dir();
        for rel in &covers {
            if let Some(path) = paths::from_db_path(&dir, rel) {
                let _ = fs::remove_file(&path);
                if let Some(parent) = path.parent() {
                    inner.prune(parent);
                }
            }
        }
        inner.db.with(|c| {
            c.execute_batch("DELETE FROM download_collections; DELETE FROM download_covers;")
        })?;
        let _ = fs::remove_dir_all(dir.join(PARTIAL_DIR));
        Ok(())
    }

    /// Everything the frontend needs to show downloads of one server.
    pub fn list(&self, server_id: &str) -> Result<Listing, String> {
        let dir = self.dir();
        let (tracks, collections) = self.inner.db.with(|c| {
            Ok((
                store::list_tracks(c, server_id)?,
                store::list_collections(c, server_id)?,
            ))
        })?;
        let tracks = tracks
            .into_iter()
            .map(|row| ListedTrack {
                absolute_path: row
                    .path
                    .as_deref()
                    .and_then(|p| paths::from_db_path(&dir, p))
                    .map(|p| p.to_string_lossy().into_owned()),
                row,
            })
            .collect();
        Ok(Listing {
            dir: dir.to_string_lossy().into_owned(),
            tracks,
            collections,
        })
    }

    /// Moves the downloads folder, with its files, to `new_dir`. Fails while downloads are running.
    pub fn move_folder(
        &self,
        new_dir: &Path,
        progress: &mut dyn FnMut(super::storage::MoveProgress),
    ) -> Result<(), String> {
        let inner = &self.inner;
        {
            let mut queue = lock(&inner.queue);
            if queue.moving || !queue.jobs.is_empty() {
                return Err("busy".into());
            }
            queue.moving = true;
        }
        let old = inner.dir();
        let result = super::storage::move_dir(&old, new_dir, progress).and_then(|()| {
            inner
                .db
                .with(|c| store::set_setting(c, store::SETTING_DIR, &new_dir.to_string_lossy()))?;
            *inner.dir.write().unwrap_or_else(|e| e.into_inner()) = new_dir.to_path_buf();
            Ok(())
        });
        lock(&inner.queue).moving = false;
        result
    }

    /// True while any download is queued or running.
    pub fn is_busy(&self) -> bool {
        !lock(&self.inner.queue).jobs.is_empty()
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        {
            let mut queue = lock(&self.inner.queue);
            queue.shutdown = true;
            for job in queue.jobs.values() {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
        self.inner.cond.notify_all();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTrack {
    #[serde(flatten)]
    pub row: TrackRow,
    pub absolute_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub dir: String,
    pub tracks: Vec<ListedTrack>,
    pub collections: Vec<CollectionRow>,
}

fn ticker(inner: Weak<Inner>) {
    loop {
        thread::sleep(FLUSH_INTERVAL);
        let Some(inner) = inner.upgrade() else { return };
        if lock(&inner.queue).shutdown {
            inner.reporter.flush();
            return;
        }
        inner.reporter.flush();
    }
}

impl Inner {
    fn dir(&self) -> PathBuf {
        self.dir.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn client(&self, insecure: bool) -> Result<BlockingClient, String> {
        let mut clients = lock(&self.clients);
        let slot = &mut clients[usize::from(insecure)];
        if let Some(client) = slot {
            return Ok(client.clone());
        }
        let client = build_http_client(insecure).map_err(|e| e.to_string())?;
        *slot = Some(client.clone());
        Ok(client)
    }

    fn worker(self: Arc<Self>) {
        loop {
            let job = {
                let mut queue = lock(&self.queue);
                loop {
                    if queue.shutdown {
                        return;
                    }
                    if let Some(job) = queue.pending.pop_front() {
                        break job;
                    }
                    queue = self.cond.wait(queue).unwrap_or_else(|e| e.into_inner());
                }
            };
            {
                let mut phase = lock(&job.phase);
                if *phase != Phase::Queued {
                    continue;
                }
                *phase = Phase::Running;
            }
            self.run_job(&job);
            let mut queue = lock(&self.queue);
            if queue
                .jobs
                .get(&job.key)
                .is_some_and(|j| Arc::ptr_eq(j, &job))
            {
                queue.jobs.remove(&job.key);
            }
        }
    }

    fn report_state(&self, key: &TrackKey, state: &str, error: Option<String>) {
        let mut update = DownloadUpdate::new(key, state);
        update.error = error;
        self.reporter.push(key, update);
    }

    fn set_row_state(&self, key: &TrackKey, state: &str, error: Option<&str>) {
        if let Err(e) = self.db.with(|c| store::set_state(c, key, state, error)) {
            log::warn!("cannot update the download state: {e}");
        }
    }

    fn part_path(&self, req: &EnqueueJob) -> PathBuf {
        self.dir().join(PARTIAL_DIR).join(paths::part_file_name(
            &req.server_id,
            &req.track_id,
            &req.quality,
        ))
    }

    fn run_job(&self, job: &Job) {
        let key = &job.key;
        let req = &job.req;
        self.set_row_state(key, STATE_DOWNLOADING, None);
        self.report_state(key, STATE_DOWNLOADING, None);

        let part = self.part_path(req);
        if let Some(parent) = part.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            return self.fail(job, format!("cannot create the downloads folder: {e}"));
        }
        let client = match self.client(req.source.allow_insecure_tls) {
            Ok(c) => c,
            Err(e) => return self.fail(job, e),
        };

        let mut attempt = 1;
        let mut last_report = Instant::now() - FLUSH_INTERVAL;
        let fetched = loop {
            let result = transfer::fetch_to_part(
                &client,
                &req.source,
                &part,
                &job.cancel,
                &mut |done, total| {
                    // The reporter coalesces; skip most calls to keep the mutex quiet.
                    if last_report.elapsed() < Duration::from_millis(40) && total != Some(done) {
                        return;
                    }
                    last_report = Instant::now();
                    let mut update = DownloadUpdate::new(key, STATE_DOWNLOADING);
                    update.bytes_done = done;
                    update.bytes_total = total;
                    self.reporter.push(key, update);
                },
            );
            match result {
                Ok(fetched) => break fetched,
                Err(TransferError::Cancelled) => {
                    let _ = fs::remove_file(&part);
                    return;
                }
                Err(e) if e.retryable() && attempt < self.retry.max_attempts => {
                    if !self.sleep_unless_cancelled(job, self.retry.delay(attempt)) {
                        let _ = fs::remove_file(&part);
                        return;
                    }
                    attempt += 1;
                }
                Err(e) => {
                    // A damaged partial file would only fail again: start over next time.
                    if matches!(e, TransferError::Http(_) | TransferError::Io(_)) {
                        let _ = fs::remove_file(&part);
                    }
                    return self.fail(job, e.message());
                }
            }
        };
        self.finish(job, &part, &fetched);
    }

    /// Waits `delay`; false if the job was cancelled meanwhile.
    fn sleep_unless_cancelled(&self, job: &Job, delay: Duration) -> bool {
        let end = Instant::now() + delay;
        while Instant::now() < end {
            if job.cancel.load(Ordering::Relaxed) {
                return false;
            }
            thread::sleep(Duration::from_millis(20).min(end - Instant::now()));
        }
        !job.cancel.load(Ordering::Relaxed)
    }

    fn fail(&self, job: &Job, message: String) {
        // A cancelled job's row is being deleted; don't resurrect it as "failed".
        if job.cancel.load(Ordering::Relaxed) {
            return;
        }
        log::warn!("download of track {} failed: {message}", job.key.track_id);
        self.set_row_state(&job.key, STATE_FAILED, Some(&message));
        self.report_state(&job.key, STATE_FAILED, Some(message));
    }

    /// Moves the finished partial file into the library layout and records it.
    fn finish(&self, job: &Job, part: &Path, fetched: &transfer::Fetched) {
        let req = &job.req;
        let key = &job.key;
        let mut phase = lock(&job.phase);
        if *phase != Phase::Running {
            let _ = fs::remove_file(part);
            return;
        }
        *phase = Phase::Finalizing;

        let ext = transfer::extension_for(req.container.as_deref(), fetched)
            .unwrap_or_else(|| "bin".to_string());
        let dir = self.dir();
        let relative = paths::relative_track_path(&req.layout, &ext, &dir);
        let placed = {
            let _guard = lock(&self.finalize_lock);
            let target = paths::unique_path(&dir.join(&relative), |p| p.exists());
            let result = target
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| fs::rename(part, &target))
                .map(|()| target.clone());
            result.map_err(|e| format!("cannot save the file: {e}"))
        };
        let target = match placed {
            Ok(target) => target,
            Err(message) => {
                *phase = Phase::Finished;
                drop(phase);
                return self.fail(job, message);
            }
        };
        let relative = target
            .strip_prefix(&dir)
            .map(paths::to_db_path)
            .unwrap_or_else(|_| paths::to_db_path(&relative));
        let stored = self
            .db
            .with(|c| store::mark_done(c, key, &relative, fetched.bytes, &ext));
        *phase = Phase::Finished;
        drop(phase);
        if let Err(message) = stored {
            return self.fail(job, message);
        }
        let mut update = DownloadUpdate::new(key, STATE_DONE);
        update.bytes_done = fetched.bytes;
        update.bytes_total = Some(fetched.bytes);
        update.size_bytes = fetched.bytes;
        update.path = Some(target.to_string_lossy().into_owned());
        self.reporter.push(key, update);

        if let Some(cover) = &req.cover
            && let Some(album_dir) = target.parent()
        {
            self.ensure_cover(&req.server_id, cover, &dir, album_dir);
        }
    }

    /// Saves the album cover once per album folder. Failures are not worth failing a track for.
    fn ensure_cover(&self, server_id: &str, cover: &CoverJob, base: &Path, album_dir: &Path) {
        let _guard = lock(&self.cover_lock);
        let known = self
            .db
            .with(|c| store::get_cover_path(c, server_id, &cover.cover_ref))
            .ok()
            .flatten();
        if let Some(rel) = known
            && paths::from_db_path(base, &rel).is_some_and(|p| p.is_file())
        {
            return;
        }
        let relative_of = |file: &Path| file.strip_prefix(base).map(paths::to_db_path).ok();
        // Another cover reference of the same album already put an image here.
        for ext in ["jpg", "png", "webp"] {
            let existing = album_dir.join(format!("cover.{ext}"));
            if existing.is_file() {
                if let Some(rel) = relative_of(&existing) {
                    let _ = self
                        .db
                        .with(|c| store::set_cover_path(c, server_id, &cover.cover_ref, &rel));
                }
                return;
            }
        }
        let Ok(client) = self.client(cover.source.allow_insecure_tls) else {
            return;
        };
        let (bytes, content_type) = match transfer::fetch_small(&client, &cover.source, COVER_LIMIT)
        {
            Ok(v) => v,
            Err(e) => {
                log::info!("cover download failed: {}", e.message());
                return;
            }
        };
        let ext = image_extension(&bytes, content_type.as_deref());
        let target = album_dir.join(format!("cover.{ext}"));
        let tmp = album_dir.join("cover.tmp");
        let written = fs::write(&tmp, &bytes).and_then(|()| fs::rename(&tmp, &target));
        if let Err(e) = written {
            let _ = fs::remove_file(&tmp);
            log::info!("cannot save the cover: {e}");
            return;
        }
        if let Some(rel) = relative_of(&target) {
            let _ = self
                .db
                .with(|c| store::set_cover_path(c, server_id, &cover.cover_ref, &rel));
        }
    }

    /// Cancels a running or queued job (if any) and deletes the track's files and row.
    fn remove_track(&self, key: &TrackKey) -> Result<(), String> {
        let job = lock(&self.queue).jobs.get(key).cloned();
        let mut quality = None;
        if let Some(job) = job {
            quality = Some(job.req.quality.clone());
            // Blocks while the worker finalizes this job, then sees `Finished` and does nothing.
            let mut phase = lock(&job.phase);
            match *phase {
                Phase::Queued | Phase::Running => {
                    job.cancel.store(true, Ordering::Relaxed);
                    *phase = Phase::Cancelled;
                    let mut queue = lock(&self.queue);
                    queue.pending.retain(|j| !Arc::ptr_eq(j, &job));
                    if queue.jobs.get(key).is_some_and(|j| Arc::ptr_eq(j, &job)) {
                        queue.jobs.remove(key);
                    }
                }
                Phase::Finalizing | Phase::Finished | Phase::Cancelled => {}
            }
        }
        let row = self.db.with(|c| store::get_track(c, key))?;
        let dir = self.dir();
        if let Some(row) = &row {
            quality = Some(row.quality.clone());
            if let Some(path) = row
                .path
                .as_deref()
                .and_then(|p| paths::from_db_path(&dir, p))
            {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => log::warn!("cannot delete a downloaded file: {e}"),
                }
                if let Some(parent) = path.parent() {
                    self.prune(parent);
                }
            }
        }
        if let Some(quality) = quality {
            let part = dir.join(PARTIAL_DIR).join(paths::part_file_name(
                &key.server_id,
                &key.track_id,
                &quality,
            ));
            let _ = fs::remove_file(part);
        }
        self.db.with(|c| store::delete_track(c, key))?;
        self.reporter.push(key, DownloadUpdate::new(key, "removed"));
        Ok(())
    }

    /// Removes `dir` and its parents up to the downloads folder when nothing but cover images is left.
    fn prune(&self, start: &Path) {
        let base = self.dir();
        let mut current = start.to_path_buf();
        while current != base && current.starts_with(&base) {
            let Ok(entries) = fs::read_dir(&current) else {
                break;
            };
            let names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            let only_covers = names.iter().all(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("cover."))
            });
            if !only_covers {
                break;
            }
            for cover in &names {
                if let Ok(rel) = cover.strip_prefix(&base) {
                    let rel = paths::to_db_path(rel);
                    let _ = self.db.with(|c| store::delete_covers_at(c, &rel));
                }
                let _ = fs::remove_file(cover);
            }
            if fs::remove_dir(&current).is_err() {
                break;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent.to_path_buf();
        }
    }
}

/// `jpg`, `png` or `webp` from the image bytes (magic numbers), else from the MIME type.
fn image_extension(bytes: &[u8], content_type: Option<&str>) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else {
        match content_type.unwrap_or("") {
            t if t.starts_with("image/png") => "png",
            t if t.starts_with("image/webp") => "webp",
            _ => "jpg",
        }
    }
}

/// Paths (relative, `/`-separated) of all files below `dir`, for diagnostics and tests.
#[cfg(test)]
pub fn files_below(dir: &Path) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    fn walk(base: &Path, dir: &Path, out: &mut HashSet<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else if let Ok(rel) = path.strip_prefix(base) {
                out.insert(paths::to_db_path(rel));
            }
        }
    }
    let mut out = HashSet::new();
    walk(dir, dir, &mut out);
    out
}

//! Download thread of one cache entry.
//!
//! The thread repeatedly plans the next request (first missing byte at the readers' wanted
//! position, then remaining gaps from the start), issues `Range: bytes=<n>-`, streams the body into
//! the sparse data file and publishes progress through the entry's `RangeSet` + condvar. It is
//! redirected when a reader misses data far from the current download position, retries network
//! failures with backoff (resuming at the current offset), and stops when the entry is complete
//! or nobody uses it any more.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_RANGE, HeaderName, HeaderValue, RANGE};

use super::cache::{Entry, FetchError, Inner};
use super::client::{describe_io, describe_reqwest};

/// A reader miss within this distance ahead of the download position just waits.
pub(crate) const LOOKAHEAD: u64 = 512 * 1024;
/// Consecutive failed attempts (without progress) before readers get an error.
const MAX_ATTEMPTS: u32 = 5;
const CHUNK: usize = 64 * 1024;
/// Persist metadata (and fsync data) every this many downloaded bytes.
const SAVE_EVERY: u64 = 2 * 1024 * 1024;

enum Plan {
    Stop,
    Fetch { start: u64, generation: u64 },
}

enum Outcome {
    /// Request finished or was abandoned on purpose; plan again.
    Replan { progressed: bool },
    /// Retryable failure. `linear_end`: offset where a forward-only (200) body broke off.
    Transient {
        error: FetchError,
        progressed: bool,
        linear_end: Option<u64>,
    },
    /// Not retryable (e.g. 404, disk error).
    Fatal(FetchError),
}

pub(crate) struct Downloader {
    inner: Arc<Inner>,
    entry: Arc<Entry>,
    writer: Option<File>,
    unsaved: u64,
}

/// Parses `bytes a-b/total`, `bytes a-b/*` or `bytes */total` into (start, total).
fn parse_content_range(value: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse().ok()?),
    };
    let start = match range.trim() {
        "*" => None,
        r => Some(r.split_once('-')?.0.trim().parse().ok()?),
    };
    Some((start, total))
}

impl Downloader {
    pub(crate) fn new(inner: Arc<Inner>, entry: Arc<Entry>) -> Self {
        Self {
            inner,
            entry,
            writer: None,
            unsaved: 0,
        }
    }

    pub(crate) fn run(mut self) {
        let mut failures = 0u32;
        let mut last_linear_end = None;
        loop {
            match self.plan() {
                Plan::Stop => {
                    // Close the data file first: stopping may delete it (temporary streams).
                    self.writer = None;
                    let (stopped, prefetch_ended, removed) =
                        self.inner.downloader_try_stop(&self.entry);
                    if !stopped {
                        continue;
                    }
                    if prefetch_ended {
                        self.inner.prefetch_finished(&self.entry.hash);
                    }
                    if removed {
                        self.inner.enforce_limit();
                    }
                    return;
                }
                Plan::Fetch { start, generation } => match self.fetch(start, generation) {
                    Outcome::Replan { progressed } => {
                        if progressed {
                            failures = 0;
                        }
                        last_linear_end = None;
                    }
                    Outcome::Transient {
                        error,
                        progressed,
                        linear_end,
                    } => {
                        if progressed {
                            failures = 0;
                        }
                        // A forward-only stream that breaks off twice at exactly the same byte is
                        // shorter than its (estimated) Content-Length: treat that byte as the end.
                        if let Some(end) = linear_end
                            && last_linear_end == Some(end)
                            && self.finish_short_stream(end)
                        {
                            failures = 0;
                            last_linear_end = None;
                            continue;
                        }
                        last_linear_end = linear_end;
                        failures += 1;
                        if failures >= MAX_ATTEMPTS {
                            failures = 0;
                            self.fail(error);
                        } else {
                            log::debug!(
                                "source {}: download attempt {failures} failed ({}), retrying",
                                self.entry.key,
                                error.message()
                            );
                            self.backoff(Duration::from_millis(250) * (1 << (failures - 1)));
                        }
                    }
                    Outcome::Fatal(error) => {
                        failures = 0;
                        last_linear_end = None;
                        self.fail(error);
                    }
                },
            }
        }
    }

    /// Ends a forward-only stream at `end` if everything before it is present.
    fn finish_short_stream(&mut self, end: u64) -> bool {
        let newly_complete = {
            let mut st = self.entry.state.lock();
            if st.seekable != Some(false) || end == 0 || !st.ranges.covers(0, end) {
                return false;
            }
            log::debug!(
                "source {}: stream ended at byte {end}, before its announced length",
                self.entry.key
            );
            st.total_len = Some(end);
            st.ranges.truncate(end);
            st.mark_complete_if_full()
        };
        self.entry.cond.notify_all();
        if newly_complete {
            if let Some(w) = self.writer.as_ref() {
                let _ = w.set_len(end);
            }
            self.sync_and_complete();
        }
        true
    }

    fn fail(&self, error: FetchError) {
        log::warn!(
            "source {}: download failed: {}",
            self.entry.key,
            error.message()
        );
        let mut st = self.entry.state.lock();
        st.dl_pos = None;
        st.error = Some(error);
        drop(st);
        self.entry.cond.notify_all();
    }

    /// Sleeps for `dur`, waking early when the entry loses all users or readers redirect it.
    fn backoff(&self, dur: Duration) {
        let deadline = Instant::now() + dur;
        let mut st = self.entry.state.lock();
        let generation = st.generation;
        while st.users() > 0 && st.generation == generation {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            self.entry.cond.wait_for(&mut st, deadline - now);
        }
    }

    fn plan(&self) -> Plan {
        let mut st = self.entry.state.lock();
        loop {
            if st.users() == 0 || st.complete {
                return Plan::Stop;
            }
            if st.error.is_some() {
                if st.readers == 0 {
                    return Plan::Stop;
                }
                // Park until a reader acknowledges the error (bumps the generation) or leaves.
                self.entry
                    .cond
                    .wait_for(&mut st, Duration::from_millis(500));
                continue;
            }
            if st.readers == 0 && self.inner.buffering_readers.load(Ordering::Relaxed) > 0 {
                // Prefetch only: yield bandwidth to a stalled reader of another entry.
                self.entry
                    .cond
                    .wait_for(&mut st, Duration::from_millis(100));
                continue;
            }
            let total = st.total_len;
            let start = if st.seekable == Some(false) {
                // Forward-only stream: always continue the contiguous prefix.
                Some(st.ranges.contiguous_end_from(0)).filter(|s| total.is_none_or(|t| *s < t))
            } else if st.readers > 0 {
                st.ranges
                    .first_gap_from(st.want_pos, total)
                    .or_else(|| st.ranges.first_gap_from(0, total))
            } else {
                st.ranges.first_gap_from(0, total)
            };
            match start {
                Some(start) => {
                    return Plan::Fetch {
                        start,
                        generation: st.generation,
                    };
                }
                None => {
                    // Everything up to the known total is present.
                    if st.mark_complete_if_full() {
                        drop(st);
                        self.entry.cond.notify_all();
                        self.inner.on_completed(&self.entry);
                        st = self.entry.state.lock();
                    } else {
                        // Unreachable in practice (total known and covered implies complete).
                        return Plan::Stop;
                    }
                }
            }
        }
    }

    fn writer(&mut self) -> std::io::Result<&mut File> {
        if self.writer.is_none() {
            let f = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&self.entry.data_path)?;
            self.writer = Some(f);
        }
        // Just set above.
        self.writer
            .as_mut()
            .ok_or_else(|| std::io::Error::other("writer unavailable"))
    }

    fn fetch(&mut self, start: u64, mut generation: u64) -> Outcome {
        let spec = self.entry.request.lock().clone();
        let client = match self.inner.client(spec.insecure) {
            Ok(c) => c,
            Err(msg) => return Outcome::Fatal(FetchError::Network(msg)),
        };
        let mut req = client.get(&spec.url);
        for (name, value) in &spec.headers {
            match (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                (Ok(n), Ok(v)) => req = req.header(n, v),
                _ => log::warn!("source {}: skipping invalid request header", self.entry.key),
            }
        }
        req = req.header(RANGE, format!("bytes={start}-"));
        log::debug!("source {}: requesting from byte {start}", self.entry.key);

        let mut resp = match req.send() {
            Ok(r) => r,
            Err(e) => {
                let error = FetchError::Network(describe_reqwest(e, &spec.url));
                return Outcome::Transient {
                    error,
                    progressed: false,
                    linear_end: None,
                };
            }
        };
        let status = resp.status().as_u16();
        let content_range = resp
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range);
        let (body_start, linear) = {
            let mut st = self.entry.state.lock();
            match status {
                206 => {
                    let (s, total) = content_range.unwrap_or((Some(start), None));
                    st.seekable = Some(true);
                    if total.is_some() {
                        st.total_len = total;
                    }
                    (s.unwrap_or(start), false)
                }
                200 => {
                    // Ranges unsupported (typical for transcodes): the body is the whole file.
                    if !st.complete {
                        st.seekable = Some(false);
                    }
                    if let Some(len) = resp.content_length() {
                        st.total_len = Some(len);
                    }
                    (0, true)
                }
                416 => {
                    // Requested start beyond the end: learn the real length and re-plan.
                    match content_range {
                        Some((_, Some(total))) if total <= start => {
                            st.total_len = Some(total);
                            st.ranges.truncate(total);
                            if st.seekable.is_none() {
                                st.seekable = Some(true);
                            }
                            drop(st);
                            self.entry.cond.notify_all();
                            return Outcome::Replan { progressed: false };
                        }
                        _ => return Outcome::Fatal(FetchError::Http(status)),
                    }
                }
                408 | 429 | 500..=599 => {
                    return Outcome::Transient {
                        error: FetchError::Http(status),
                        progressed: false,
                        linear_end: None,
                    };
                }
                _ => return Outcome::Fatal(FetchError::Http(status)),
            }
        };
        self.entry.cond.notify_all();

        let mut off = body_start;
        self.entry.state.lock().dl_pos = Some(off);
        let mut buf = vec![0u8; CHUNK];
        let mut progressed = false;
        loop {
            let n = match resp.read(&mut buf) {
                Ok(n) => n,
                Err(e) => {
                    self.entry.state.lock().dl_pos = None;
                    let error = FetchError::Network(describe_io(&e, &spec.url));
                    return Outcome::Transient {
                        error,
                        progressed,
                        linear_end: linear.then_some(off),
                    };
                }
            };
            if n == 0 {
                let mut st = self.entry.state.lock();
                st.dl_pos = None;
                match st.total_len {
                    None => st.total_len = Some(off),
                    Some(t) if off < t => {
                        drop(st);
                        let error = FetchError::Network(
                            "connection closed before the end of the stream".into(),
                        );
                        return Outcome::Transient {
                            error,
                            progressed,
                            linear_end: linear.then_some(off),
                        };
                    }
                    Some(_) => {}
                }
                let newly_complete = st.mark_complete_if_full();
                drop(st);
                self.entry.cond.notify_all();
                if newly_complete {
                    self.sync_and_complete();
                }
                return Outcome::Replan { progressed };
            }

            let chunk_end = off + n as u64;
            let (missing, end) = {
                let st = self.entry.state.lock();
                let end = st.total_len.map_or(chunk_end, |t| chunk_end.min(t));
                (
                    if off < end {
                        st.ranges.missing_within(off, end)
                    } else {
                        Vec::new()
                    },
                    end,
                )
            };
            for &(a, b) in &missing {
                let slice = &buf[(a - off) as usize..(b - off) as usize];
                let res = self.writer().and_then(|w| {
                    w.seek(SeekFrom::Start(a))?;
                    w.write_all(slice)
                });
                if let Err(e) = res {
                    self.entry.state.lock().dl_pos = None;
                    return Outcome::Fatal(FetchError::Io(format!("cache write failed: {e}")));
                }
            }
            let newly_complete = {
                let mut st = self.entry.state.lock();
                for &(a, b) in &missing {
                    st.ranges.insert(a, b);
                    self.unsaved += b - a;
                }
                progressed |= !missing.is_empty();
                off = chunk_end;
                st.dl_pos = Some(off);
                st.mark_complete_if_full()
            };
            self.entry.cond.notify_all();
            if newly_complete {
                self.entry.state.lock().dl_pos = None;
                self.sync_and_complete();
                return Outcome::Replan { progressed };
            }
            if self.unsaved >= SAVE_EVERY {
                self.unsaved = 0;
                if let Some(w) = self.writer.as_ref() {
                    let _ = w.sync_data();
                }
                self.inner.save_meta(&self.entry);
                self.inner.enforce_limit();
            }

            // Control: stop, redirect, or skip already downloaded data.
            let mut st = self.entry.state.lock();
            if st.users() == 0 || st.total_len.is_some_and(|t| end >= t && off >= t) {
                st.dl_pos = None;
                return Outcome::Replan { progressed };
            }
            if !linear {
                if st.ranges.contains(off) {
                    st.dl_pos = None;
                    return Outcome::Replan { progressed };
                }
                if st.generation != generation {
                    generation = st.generation;
                    let want = st.want_pos;
                    let near = off <= want && want < off + LOOKAHEAD;
                    if !near && !st.ranges.contains(want) && st.readers > 0 {
                        st.dl_pos = None;
                        return Outcome::Replan { progressed };
                    }
                }
            }
            // Prefetch only: pause while a reader elsewhere is stalled.
            while st.readers == 0
                && st.users() > 0
                && self.inner.buffering_readers.load(Ordering::Relaxed) > 0
            {
                self.entry
                    .cond
                    .wait_for(&mut st, Duration::from_millis(100));
            }
        }
    }

    fn sync_and_complete(&mut self) {
        if let Some(w) = self.writer.as_ref() {
            let _ = w.sync_data();
        }
        self.unsaved = 0;
        self.inner.on_completed(&self.entry);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_content_range;

    #[test]
    fn content_range() {
        assert_eq!(
            parse_content_range("bytes 0-99/1000"),
            Some((Some(0), Some(1000)))
        );
        assert_eq!(
            parse_content_range("bytes 100-199/*"),
            Some((Some(100), None))
        );
        assert_eq!(
            parse_content_range("bytes */1000"),
            Some((None, Some(1000)))
        );
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(parse_content_range("bytes x-1/2"), None);
    }
}

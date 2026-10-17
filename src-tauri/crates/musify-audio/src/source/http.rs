//! `CachedHttpSource`: the decoder-facing reader of a (partially) cached HTTP entry.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use parking_lot::MutexGuard;

use super::cache::{Entry, EntryState, Holder, Inner};
use super::download::LOOKAHEAD;
use super::{ByteSource, SourceEvent};

/// Reads stalled longer than this report `SourceEvent::Buffering`.
const BUFFERING_AFTER: Duration = Duration::from_millis(150);

/// A registered reader reference: keeps the entry open (protected from eviction) until dropped.
pub(crate) struct EntryRef {
    pub inner: Arc<Inner>,
    pub entry: Arc<Entry>,
}

impl Drop for EntryRef {
    fn drop(&mut self) {
        self.inner.release(&self.entry, Holder::Reader);
    }
}

pub(crate) struct CachedHttpSource {
    // Field order matters: the file handle closes before the entry reference is released (which
    // may delete the file).
    file: File,
    pos: u64,
    r: EntryRef,
}

impl CachedHttpSource {
    pub(crate) fn new(r: EntryRef) -> io::Result<Self> {
        let file = File::open(&r.entry.data_path)?;
        Ok(Self { file, pos: 0, r })
    }

    fn set_buffering(&self, active: bool) {
        if active {
            self.r
                .inner
                .buffering_readers
                .fetch_add(1, Ordering::Relaxed);
        } else {
            self.r
                .inner
                .buffering_readers
                .fetch_sub(1, Ordering::Relaxed);
        }
        log::debug!(
            "source {}: buffering {}",
            self.r.entry.key,
            if active { "started" } else { "ended" }
        );
        self.r.inner.emit(SourceEvent::Buffering {
            cache_key: self.r.entry.key.clone(),
            active,
        });
    }

    /// Waits until bytes at `self.pos` are available; returns how many can be read (0 = EOF).
    fn wait_available(&self, max: usize) -> io::Result<usize> {
        let entry = &self.r.entry;
        let started = Instant::now();
        let mut buffering = false;
        let mut st = entry.state.lock();
        let result = loop {
            if let Some(total) = st.total_len
                && self.pos >= total
            {
                break Ok(0);
            }
            let end = st.ranges.contiguous_end_from(self.pos);
            if end > self.pos {
                break Ok(usize::try_from(end - self.pos)
                    .unwrap_or(usize::MAX)
                    .min(max));
            }
            if let Some(error) = st.error.take() {
                // Acknowledge: the next read retries the download.
                st.generation += 1;
                entry.cond.notify_all();
                break Err(error.to_io_error());
            }
            if st.complete {
                break Ok(0);
            }
            self.request_position(&mut st);
            let timeout = if buffering {
                Duration::from_millis(100)
            } else {
                BUFFERING_AFTER
                    .saturating_sub(started.elapsed())
                    .max(Duration::from_millis(1))
            };
            entry.cond.wait_for(&mut st, timeout);
            if !buffering && started.elapsed() >= BUFFERING_AFTER && !st.ranges.contains(self.pos) {
                buffering = true;
                MutexGuard::unlocked(&mut st, || self.set_buffering(true));
            }
        };
        drop(st);
        if buffering {
            self.set_buffering(false);
        }
        result
    }

    /// Makes sure the download heads for `self.pos`.
    fn request_position(&self, st: &mut EntryState) {
        if st.seekable == Some(true) {
            let near = st
                .dl_pos
                .is_some_and(|p| p <= self.pos && self.pos < p + LOOKAHEAD);
            if !near && st.want_pos != self.pos {
                st.want_pos = self.pos;
                st.generation += 1;
                self.r.entry.cond.notify_all();
            }
        }
        if !st.downloader_running {
            self.r.inner.spawn_downloader(&self.r.entry, st);
        }
    }
}

impl Read for CachedHttpSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = self.wait_available(buf.len())?;
        if n == 0 {
            return Ok(0);
        }
        self.file.seek(SeekFrom::Start(self.pos))?;
        self.file.read_exact(&mut buf[..n])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for CachedHttpSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let st = self.r.entry.state.lock();
        let target = match pos {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            SeekFrom::End(d) => match st.total_len {
                Some(t) => t.checked_add_signed(d),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "stream length unknown",
                    ));
                }
            },
        };
        let target = target
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid seek position"))?;
        if !st.is_seekable() && target > st.ranges.contiguous_end_from(0) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "stream is not seekable beyond the downloaded data",
            ));
        }
        self.pos = target;
        Ok(target)
    }
}

impl ByteSource for CachedHttpSource {
    fn byte_len(&self) -> Option<u64> {
        self.r.entry.state.lock().total_len
    }

    fn is_seekable(&self) -> bool {
        self.r.entry.state.lock().is_seekable()
    }
}

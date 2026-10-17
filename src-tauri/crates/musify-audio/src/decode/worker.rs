//! The per-track decoding thread behind [`super::TrackWorker`].

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::Thread;
use std::time::Duration;

use crossbeam_channel::Sender;
use parking_lot::Mutex;

use super::{Conformer, DecodeError, Decoder, TrackWorkerConfig, WorkerEvent};
use crate::api::TrackId;
use crate::source::{OpenedSource, SourceError};

/// How long the worker sleeps when the ring is full (it is also woken by `stop`).
const FULL_WAIT: Duration = Duration::from_millis(3);

pub(crate) struct Control {
    stop: AtomicBool,
    running: AtomicBool,
    thread: Mutex<Option<Thread>>,
}

impl Control {
    pub(crate) fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.lock().as_ref() {
            t.unpark();
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

type OpenFn = Box<dyn FnOnce() -> Result<OpenedSource, SourceError> + Send>;

pub(crate) fn spawn(
    id: TrackId,
    open: OpenFn,
    hint: Option<String>,
    config: TrackWorkerConfig,
    events: Sender<WorkerEvent>,
) -> (Arc<Control>, rtrb::Consumer<f64>) {
    let (producer, consumer) = rtrb::RingBuffer::new(config.ring_frames.max(1) * 2);
    let control = Arc::new(Control {
        stop: AtomicBool::new(false),
        running: AtomicBool::new(true),
        thread: Mutex::new(None),
    });
    let ctl = control.clone();
    let thread_events = events.clone();
    let thread_id = id.clone();
    let name: String = format!(
        "musify-decode-{}",
        id.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(24)
            .collect::<String>()
    );
    let spawned = std::thread::Builder::new().name(name).spawn(move || {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut job = Job {
                id: thread_id.clone(),
                control: &ctl,
                events: &thread_events,
                producer,
            };
            job.run(open, hint.as_deref(), &config)
        }));
        let error = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".into());
                log::error!("decode worker panicked: {msg}");
                Some(DecodeError::Decode(format!("decoder panicked: {msg}")))
            }
        };
        if let Some(e) = error
            && !ctl.stopped()
        {
            let _ = thread_events.send(WorkerEvent::Error {
                id: thread_id,
                error: Arc::new(e),
            });
        }
        ctl.running.store(false, Ordering::Release);
    });
    match spawned {
        Ok(handle) => {
            *control.thread.lock() = Some(handle.thread().clone());
            // Detached: dropping the handle never blocks the engine.
        }
        Err(e) => {
            control.running.store(false, Ordering::Release);
            let _ = events.send(WorkerEvent::Error {
                id,
                error: Arc::new(DecodeError::Io(e)),
            });
        }
    }
    (control, consumer)
}

struct Job<'a> {
    id: TrackId,
    control: &'a Control,
    events: &'a Sender<WorkerEvent>,
    producer: rtrb::Producer<f64>,
}

/// Why pushing stopped early.
struct Stopped;

impl Job<'_> {
    fn run(
        &mut self,
        open: OpenFn,
        hint: Option<&str>,
        config: &TrackWorkerConfig,
    ) -> Result<(), DecodeError> {
        let opened = open()?;
        if self.cancelled() {
            return Ok(());
        }
        let mut decoder = Decoder::open(opened.source, hint)?;
        let src_rate = decoder.sample_rate();
        let dst_rate = config.dst_rate.max(1);
        let base_ms = opened.starts_at_ms;
        if config.start_ms > base_ms {
            decoder.seek(config.start_ms - base_ms)?;
        }
        if self.cancelled() {
            return Ok(());
        }
        // Absolute device-rate frame of the first sample: the stream's own start (time-offset
        // restarts of transcodes) plus the decoder position, both rounded to device frames.
        let base_frames = (u128::from(base_ms) * u128::from(dst_rate) / 1000) as u64;
        let src_pos = decoder.position_frames();
        let start_frame = base_frames + rescale(src_pos, src_rate, dst_rate);

        let mut conformer = Conformer::with_layout(src_rate, decoder.channel_layout(), dst_rate);
        let info = decoder.info().clone();
        let mut ready = Some(WorkerEvent::Ready {
            id: self.id.clone(),
            info,
            start_frame,
        });

        let mut native = Vec::with_capacity(16384);
        let mut conformed = Vec::with_capacity(16384);
        let mut pushed: u64 = 0;
        loop {
            native.clear();
            let n = decoder.next_frames(&mut native)?;
            conformed.clear();
            if n == 0 {
                conformer.flush(&mut conformed);
            } else {
                conformer.process(&native, &mut conformed);
            }
            // Ready goes out with the first audio (or at the end of an empty stream), before the
            // push that may wait for ring space.
            if let Some(ev) = ready.take_if(|_| !conformed.is_empty() || n == 0) {
                let _ = self.events.send(ev);
            }
            if self.push(&conformed).is_err() {
                return Ok(());
            }
            pushed += (conformed.len() / 2) as u64;
            if n == 0 {
                break;
            }
        }
        let _ = self.events.send(WorkerEvent::Finished {
            id: self.id.clone(),
            end_frame: start_frame + pushed,
        });
        Ok(())
    }

    fn cancelled(&self) -> bool {
        self.control.stopped() || self.producer.is_abandoned()
    }

    /// Pushes all of `data` (whole stereo frames), waiting while the ring is full.
    fn push(&mut self, data: &[f64]) -> Result<(), Stopped> {
        let mut off = 0;
        while off < data.len() {
            if self.cancelled() {
                return Err(Stopped);
            }
            let n = self.producer.slots().min(data.len() - off) & !1;
            if n > 0 {
                // Cannot fail: `n` <= free slots.
                let _ = self.producer.push_entire_slice(&data[off..off + n]);
                off += n;
            } else {
                std::thread::park_timeout(FULL_WAIT);
            }
        }
        if self.cancelled() {
            Err(Stopped)
        } else {
            Ok(())
        }
    }
}

/// `frames * dst / src`, rounded to nearest.
fn rescale(frames: u64, src: u32, dst: u32) -> u64 {
    if src == dst || src == 0 {
        return frames;
    }
    let num = u128::from(frames) * u128::from(dst);
    let den = u128::from(src);
    ((num + den / 2) / den) as u64
}

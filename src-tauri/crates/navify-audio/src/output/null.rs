//! A device-less [`OutputStream`] for engine tests: consumes the ring on its own thread and records
//! what a device would have played.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rtrb::Consumer;

use super::OutputStream;
use super::ramp::Control;
use super::render::{FillMode, Renderer};
use crate::ENGINE_CHANNELS;
use crate::api::OutputFormat;

/// Frames per simulated device callback.
pub const NULL_BLOCK_FRAMES: usize = 512;

/// How fast [`NullOutput`] consumes the ring.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NullPacing {
    /// Like a device: one block every `NULL_BLOCK_FRAMES / sample_rate` seconds. Underruns are padded
    /// with silence (recorded) and counted as xruns; silence is recorded while paused.
    RealTime,
    /// As fast as data arrives. Only frames backed by ring data are recorded (no padding, no
    /// xruns, nothing recorded while paused), so the recording equals the pushed samples except for
    /// pause/play ramps.
    Unpaced,
}

/// Shared handle to the recorded interleaved stereo samples.
pub type NullSamples = Arc<Mutex<Vec<f32>>>;

pub struct NullOutput {
    format: OutputFormat,
    control: Arc<Control>,
    samples: NullSamples,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl NullOutput {
    /// Starts consuming `ring` (interleaved stereo f32 at `sample_rate`) immediately, playing at
    /// unity gain. The same pause/play ramp and underrun logic as the real backends applies.
    pub fn new(ring: Consumer<f32>, sample_rate: u32, pacing: NullPacing) -> Self {
        let control = Control::new();
        let samples: NullSamples = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let control = control.clone();
            let samples = samples.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("navify-null-output".into())
                .spawn(move || run(ring, sample_rate, pacing, control, samples, stop))
                .expect("spawn null output thread")
        };
        let format = OutputFormat {
            device_name: "Null output".into(),
            sample_rate,
            channels: ENGINE_CHANNELS as u16,
            exclusive: false,
            bit_perfect: false,
        };
        Self {
            format,
            control,
            samples,
            stop,
            thread: Some(thread),
        }
    }

    /// Handle to the recording; keep it before boxing the stream as `Box<dyn OutputStream>`.
    pub fn sample_buffer(&self) -> NullSamples {
        self.samples.clone()
    }

    /// Copy of everything recorded so far.
    pub fn samples(&self) -> Vec<f32> {
        self.samples.lock().clone()
    }

    /// Removes and returns everything recorded so far.
    pub fn take_samples(&self) -> Vec<f32> {
        std::mem::take(&mut *self.samples.lock())
    }
}

fn run(
    mut ring: Consumer<f32>,
    sample_rate: u32,
    pacing: NullPacing,
    control: Arc<Control>,
    samples: NullSamples,
    stop: Arc<AtomicBool>,
) {
    let mut renderer = Renderer::new(ENGINE_CHANNELS as u16, sample_rate, control);
    let mut block = vec![0.0f32; NULL_BLOCK_FRAMES * ENGINE_CHANNELS];
    let period = Duration::from_secs_f64(NULL_BLOCK_FRAMES as f64 / f64::from(sample_rate.max(1)));
    let mut deadline = Instant::now();
    while !stop.load(Ordering::Acquire) {
        match pacing {
            NullPacing::RealTime => {
                renderer.render(&mut ring, &mut block);
                samples.lock().extend_from_slice(&block);
                deadline += period;
                let now = Instant::now();
                if deadline > now {
                    std::thread::sleep(deadline - now);
                } else if now - deadline > period * 8 {
                    deadline = now; // fell far behind (debugger, loaded CI): don't burst
                }
            }
            NullPacing::Unpaced => {
                let frames = renderer.render_with(&mut ring, &mut block, FillMode::Available);
                if frames > 0 {
                    samples
                        .lock()
                        .extend_from_slice(&block[..frames * ENGINE_CHANNELS]);
                } else {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }
}

impl Drop for NullOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl OutputStream for NullOutput {
    fn format(&self) -> &OutputFormat {
        &self.format
    }

    fn play(&mut self) {
        self.control.set_paused(false);
    }

    fn pause(&mut self) {
        self.control.set_paused(true);
    }

    fn xruns(&self) -> u64 {
        self.control.xruns()
    }

    fn flush(&mut self) {
        self.control.request_flush();
    }
}

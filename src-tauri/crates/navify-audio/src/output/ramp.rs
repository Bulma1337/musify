//! Lock-free pause/play control shared between a stream handle and its real-time callback, and the
//! click-free gain ramp applied inside the callback.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Ramp length for pause/play.
pub const RAMP_MS: f64 = 5.0;

/// State written by the control side (`play`/`pause`) and read by the audio callback, plus the
/// xrun counter written by the callback. Atomics only.
#[derive(Debug, Default)]
pub struct Control {
    paused: AtomicBool,
    xruns: AtomicU64,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn xruns(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }

    pub fn add_xrun(&self) {
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }
}

/// Number of frames of a [`RAMP_MS`] ramp at `sample_rate` (at least 1).
pub fn ramp_frames(sample_rate: u32) -> u32 {
    ((f64::from(sample_rate) * RAMP_MS / 1000.0).round() as u32).max(1)
}

/// A per-frame gain ramp between 0 and 1 with a smoothstep shape.
///
/// The gain is a function of an integer position `0..=len`, so it reaches exactly 0.0 and exactly
/// 1.0 at the ends (unity gain is bit-transparent) and is strictly monotonic in between.
#[derive(Clone, Debug)]
pub struct Ramp {
    pos: u32,
    len: u32,
    up: bool,
}

impl Ramp {
    /// A ramp of `len` frames, starting at unity gain (no fade at stream start).
    pub fn new(len: u32) -> Self {
        let len = len.max(1);
        Self { pos: len, len, up: true }
    }

    pub fn for_rate(sample_rate: u32) -> Self {
        Self::new(ramp_frames(sample_rate))
    }

    pub fn len_frames(&self) -> u32 {
        self.len
    }

    /// `true` = towards unity (playing), `false` = towards silence (paused).
    pub fn set_target(&mut self, up: bool) {
        self.up = up;
    }

    pub fn target_up(&self) -> bool {
        self.up
    }

    /// Steady state at unity gain: samples pass unchanged.
    #[inline]
    pub fn is_unity(&self) -> bool {
        self.up && self.pos == self.len
    }

    /// Steady state at zero gain: output silence, consume nothing.
    #[inline]
    pub fn is_silent(&self) -> bool {
        !self.up && self.pos == 0
    }

    /// Frames until the gain reaches zero (only meaningful while ramping down).
    #[inline]
    pub fn frames_until_silent(&self) -> u32 {
        if self.up { u32::MAX } else { self.pos }
    }

    /// Current gain without advancing.
    #[inline]
    pub fn gain(&self) -> f32 {
        if self.pos >= self.len {
            return 1.0;
        }
        if self.pos == 0 {
            return 0.0;
        }
        let t = self.pos as f32 / self.len as f32;
        t * t * (3.0 - 2.0 * t)
    }

    /// Advances one frame towards the target and returns the gain for that frame.
    #[inline]
    pub fn step(&mut self) -> f32 {
        if self.up {
            if self.pos < self.len {
                self.pos += 1;
            }
        } else if self.pos > 0 {
            self.pos -= 1;
        }
        self.gain()
    }
}

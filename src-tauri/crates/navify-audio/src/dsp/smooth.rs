//! Parameter smoothing shared by all stages.
//!
//! The chain runs on a fixed grid of [`CHUNK`]-frame chunks (independent of the host's buffer
//! size). At every chunk boundary each moving parameter takes one step of its smoother: two
//! cascaded one-pole sections (τ = 10 ms each, i.e. a critically damped glide that reaches 63 % after
//! ≈ 21 ms and 99.9 % after ≈ 90 ms). Unlike a single one-pole, the cascade starts with zero slope,
//! so a parameter step never produces a kink in the gain envelope. Filter coefficients are
//! designed from the smoothed parameters at each boundary and interpolated per sample; gains are
//! interpolated linearly across the chunk. Once a parameter reaches its target it snaps to it
//! exactly and costs nothing more.

use std::f64::consts::PI;

use super::biquad::{Coeffs, FilterSpec, StereoState, process_stereo, process_stereo_ramp};

/// Frames per smoothing step / coefficient update.
pub const CHUNK: usize = 32;
/// Time constant of each of the two cascaded one-pole sections (gains, frequencies and Q).
pub const SMOOTH_TAU_S: f64 = 0.010;
/// Length of the old→new crossfade for structural changes.
pub const CROSSFADE_S: f64 = 0.030;

/// One-pole coefficient for one chunk step.
pub fn chunk_alpha(sample_rate: f64, tau_s: f64) -> f64 {
    1.0 - (-(CHUNK as f64) / (tau_s * sample_rate)).exp()
}

/// Crossfade length in chunks.
pub fn crossfade_chunks(sample_rate: f64) -> u32 {
    ((CROSSFADE_S * sample_rate / CHUNK as f64).ceil() as u32).max(1)
}

/// Position of frame `i` (0-based within the chunk) on the chunk's 0…1 ramp; the last frame is 1.
#[inline]
pub fn chunk_frac(i: usize) -> f64 {
    (i + 1) as f64 * (1.0 / CHUNK as f64)
}

/// A smoothed scalar (gain). `start` is its value at the previous chunk boundary, `end` at the
/// current one; [`Ramp::at`] interpolates linearly in between. `mid` is the first smoother stage.
#[derive(Clone, Debug)]
pub struct Ramp {
    start: f64,
    end: f64,
    mid: f64,
    target: f64,
}

#[inline]
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 + 1e-7 * b.abs()
}

impl Ramp {
    pub fn new(value: f64) -> Self {
        Self {
            start: value,
            end: value,
            mid: value,
            target: value,
        }
    }

    pub fn set_target(&mut self, target: f64) {
        if target.is_finite() {
            self.target = target;
        }
    }

    pub fn target(&self) -> f64 {
        self.target
    }

    /// Value at the end of the current chunk.
    pub fn value(&self) -> f64 {
        self.end
    }

    pub fn snap(&mut self) {
        self.start = self.target;
        self.end = self.target;
        self.mid = self.target;
    }

    /// One chunk step.
    #[inline]
    pub fn advance(&mut self, alpha: f64) {
        self.start = self.end;
        if self.end != self.target || self.mid != self.target {
            self.mid += (self.target - self.mid) * alpha;
            if close(self.mid, self.target) {
                self.mid = self.target;
            }
            self.end += (self.mid - self.end) * alpha;
            if self.mid == self.target && close(self.end, self.target) {
                self.end = self.target;
            }
        }
    }

    #[inline]
    pub fn is_static(&self) -> bool {
        self.start == self.end && self.end == self.target && self.mid == self.target
    }

    #[inline]
    pub fn is_static_at(&self, value: f64) -> bool {
        self.is_static() && self.end == value
    }

    /// Value at frame `i` of the chunk.
    #[inline]
    pub fn at(&self, i: usize) -> f64 {
        self.start + (self.end - self.start) * chunk_frac(i)
    }
}

/// Raised-cosine crossfade weight driven in chunk steps (0 = off/old, 1 = on/new). Reversible.
#[derive(Clone, Debug)]
pub struct Fade {
    k: u32,
    n: u32,
    target: u32,
    w0: f64,
    w1: f64,
}

impl Fade {
    pub fn new(n_chunks: u32, on: bool) -> Self {
        let n = n_chunks.max(1);
        let k = if on { n } else { 0 };
        let w = if on { 1.0 } else { 0.0 };
        Self {
            k,
            n,
            target: k,
            w0: w,
            w1: w,
        }
    }

    fn weight(&self, k: u32) -> f64 {
        if k == 0 {
            0.0
        } else if k >= self.n {
            1.0
        } else {
            0.5 - 0.5 * (PI * k as f64 / self.n as f64).cos()
        }
    }

    pub fn set_on(&mut self, on: bool) {
        self.target = if on { self.n } else { 0 };
    }

    /// Starts a fresh 0 → 1 fade (the first [`Fade::advance`] makes it move).
    pub fn restart(&mut self) {
        self.k = 0;
        self.w0 = 0.0;
        self.w1 = 0.0;
        self.target = self.n;
    }

    #[inline]
    pub fn advance(&mut self) {
        self.w0 = self.w1;
        if self.k < self.target {
            self.k += 1;
        } else if self.k > self.target {
            self.k -= 1;
        }
        self.w1 = self.weight(self.k);
    }

    /// Keeps the current weight for one more chunk (no movement).
    pub fn hold(&mut self) {
        self.w0 = self.w1;
    }

    pub fn snap(&mut self) {
        self.k = self.target;
        self.w1 = self.weight(self.k);
        self.w0 = self.w1;
    }

    #[inline]
    pub fn is_static(&self) -> bool {
        self.k == self.target && self.w0 == self.w1
    }

    #[inline]
    pub fn is_static_on(&self) -> bool {
        self.is_static() && self.k == self.n
    }

    #[inline]
    pub fn is_static_off(&self) -> bool {
        self.is_static() && self.k == 0
    }

    #[inline]
    pub fn at(&self, i: usize) -> f64 {
        self.w0 + (self.w1 - self.w0) * chunk_frac(i)
    }
}

/// Convergence thresholds for (ln f, gain dB, ln Q).
const PARAM_EPS: [f64; 3] = [1e-5, 1e-4, 1e-5];

/// A biquad whose frequency (log domain), gain (dB) and Q (log domain) glide to their targets.
/// Coefficients are designed once per chunk while moving and interpolated linearly per sample
/// between the chunk boundaries (no coefficient steps, hence no transients excited at the poles).
/// When settled they equal `target.coeffs(fs)` exactly, i.e. what the response functions report.
#[derive(Clone, Debug)]
pub struct SmoothFilter {
    spec: FilterSpec,
    cur: [f64; 3],
    mid: [f64; 3],
    tgt: [f64; 3],
    settled: bool,
    /// Coefficients at the start of the current chunk.
    prev: Coeffs,
    /// Coefficients at the end of the current chunk.
    coeffs: Coeffs,
    fs: f64,
}

fn params(s: &FilterSpec) -> [f64; 3] {
    [s.freq_hz.ln(), s.gain_db, s.q.ln()]
}

impl SmoothFilter {
    /// A filter already settled at `spec`.
    pub fn new(spec: FilterSpec, sample_rate: f64) -> Self {
        let spec = spec.clamped(sample_rate);
        let p = params(&spec);
        let c = spec.coeffs(sample_rate);
        Self {
            spec,
            cur: p,
            mid: p,
            tgt: p,
            settled: true,
            prev: c,
            coeffs: c,
            fs: sample_rate,
        }
    }

    pub fn spec(&self) -> &FilterSpec {
        &self.spec
    }

    pub fn coeffs(&self) -> &Coeffs {
        &self.coeffs
    }

    pub fn is_settled(&self) -> bool {
        self.settled
    }

    /// Settled and not interpolating within the current chunk.
    #[inline]
    pub fn is_static(&self) -> bool {
        self.settled && self.prev == self.coeffs
    }

    /// Static with a 0 dB gain (identity for peaking/shelf filters): the filter can be skipped.
    #[inline]
    pub fn is_settled_flat(&self) -> bool {
        self.is_static() && self.spec.gain_db == 0.0
    }

    /// Coefficients for frame `i` of the current chunk.
    #[inline]
    pub fn coeffs_at(&self, i: usize) -> Coeffs {
        if self.prev == self.coeffs {
            self.coeffs
        } else {
            Coeffs::lerp(&self.prev, &self.coeffs, chunk_frac(i))
        }
    }

    /// Filters `block` (frames `off..` of the current chunk) in place.
    #[inline]
    pub fn process(&self, st: &mut StereoState, block: &mut [f64], off: usize) {
        if self.prev == self.coeffs {
            process_stereo(&self.coeffs, st, block);
        } else {
            process_stereo_ramp(
                &self.prev,
                &self.coeffs,
                off + 1,
                1.0 / CHUNK as f64,
                st,
                block,
            );
        }
    }

    /// Glides to `spec`. A different filter kind is applied immediately (callers crossfade those).
    pub fn set_target(&mut self, spec: FilterSpec) {
        let spec = spec.clamped(self.fs);
        if spec == self.spec {
            return;
        }
        if spec.kind != self.spec.kind {
            *self = Self::new(spec, self.fs);
            return;
        }
        self.spec = spec;
        self.tgt = params(&spec);
        self.settled = false;
    }

    /// Jumps to the target (no interpolation).
    pub fn snap(&mut self) {
        self.cur = self.tgt;
        self.mid = self.tgt;
        self.coeffs = self.spec.coeffs(self.fs);
        self.prev = self.coeffs;
        self.settled = true;
    }

    /// One chunk step.
    #[inline]
    pub fn update(&mut self, alpha: f64) {
        self.prev = self.coeffs;
        if self.settled {
            return;
        }
        let mut done = true;
        for (((c, m), t), eps) in self
            .cur
            .iter_mut()
            .zip(&mut self.mid)
            .zip(self.tgt)
            .zip(PARAM_EPS)
        {
            *m += (t - *m) * alpha;
            if (t - *m).abs() <= eps * 1e-3 {
                *m = t;
            }
            *c += (*m - *c) * alpha;
            if *m == t && (t - *c).abs() <= eps {
                *c = t;
            } else {
                done = false;
            }
        }
        if done {
            self.cur = self.tgt;
            self.coeffs = self.spec.coeffs(self.fs);
            self.settled = true;
        } else {
            self.coeffs = Coeffs::design(
                self.spec.kind,
                self.cur[0].exp(),
                self.cur[1],
                self.cur[2].exp(),
                self.fs,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::FilterKind;

    #[test]
    fn dsp_ramp_converges_and_snaps() {
        let mut r = Ramp::new(1.0);
        r.set_target(0.0);
        let a = chunk_alpha(48_000.0, SMOOTH_TAU_S);
        let mut steps = 0;
        while !r.is_static() {
            let before = r.value();
            r.advance(a);
            assert!(r.value() <= before, "monotonic, no overshoot");
            steps += 1;
            assert!(steps < 10_000);
        }
        assert_eq!(r.value(), 0.0);
        // Two 10 ms sections: settling to 1e-9 takes ≈ 26 τ ≈ 260 ms ≈ 390 chunks at 48 kHz.
        assert!(steps > 200 && steps < 800, "{steps}");
    }

    #[test]
    fn dsp_fade_is_monotonic_and_reversible() {
        let mut f = Fade::new(10, false);
        assert!(f.is_static_off());
        f.set_on(true);
        let mut last = 0.0;
        for _ in 0..10 {
            f.advance();
            assert!(f.at(CHUNK - 1) >= last);
            last = f.at(CHUNK - 1);
        }
        assert_eq!(last, 1.0);
        f.advance();
        assert!(f.is_static_on());
        f.set_on(false);
        f.advance();
        assert!(f.at(0) < 1.0);
    }

    #[test]
    fn dsp_smooth_filter_settles_exactly() {
        let fs = 48_000.0;
        let mut f = SmoothFilter::new(FilterSpec::new(FilterKind::Peaking, 1000.0, 0.0, 1.0), fs);
        let target = FilterSpec::new(FilterKind::Peaking, 3000.0, 6.0, 2.0);
        f.set_target(target);
        let a = chunk_alpha(fs, SMOOTH_TAU_S);
        let mut n = 0;
        while !f.is_static() {
            f.update(a);
            n += 1;
            assert!(n < 10_000);
        }
        assert_eq!(*f.coeffs(), target.coeffs(fs));
    }
}

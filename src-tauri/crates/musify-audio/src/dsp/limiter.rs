//! Stereo-linked look-ahead true-peak limiter (ceiling −1 dBTP).
//!
//! Signal flow per frame:
//! 1. **Detection** — 4× oversampled peak, maximum over both channels, of the sample itself, three
//!    interpolated points from a polyphase windowed-sinc FIR (48 taps per phase, Kaiser β = 4: within
//!    ±0.06 dB up to 0.47·fs, −1 dB at 0.48·fs) and the four points of the ITU-R BS.1770-4 Annex 2
//!    interpolator (whose passband ripple over-reads some frequencies; including it makes the output
//!    compliant with the normative dBTP meter as well). The peak of frame `m` covers the interval
//!    `[m, m+1)`; frame `m` needs the maximum of the intervals on both sides, `max(p[m−1], p[m])`.
//!    The interpolator needs 24 frames of future.
//!
//!    Limitation: content above ≈ 0.47·fs (20.7 kHz at 44.1 kHz) is under-read, as by any short 4×
//!    interpolator. Full-band white noise at +6 dBFS therefore measures −1.3 dBTP on the BS.1770 meter
//!    but ≈ −0.6 dBTP on a 128-tap reference; band-limited program material stays at −1.0 dBTP.
//! 2. **Required gain** `g[m] = min(1, ceiling / peak)`.
//! 3. **Look-ahead**: sliding minimum of `g` over `L` frames → release (one-pole towards the
//!    minimum, 100 ms, attack is instant here) → moving average over the same `L` frames. Every value
//!    in the average window is ≤ `g[p]` once frame `p` is at the end of the window, so the applied
//!    gain at frame `p` never exceeds the required gain (exact, not approximate), and the attack is a
//!    smooth ramp spread over the whole look-ahead.
//! 4. The audio is delayed by `24 + L − 1` frames (= [`TruePeakLimiter::latency`]).

use std::f64::consts::PI;

/// Taps per polyphase branch.
const TAPS: usize = 48;
const HALF: usize = TAPS / 2;
/// Kaiser window β of the interpolator.
const KAISER_BETA: f64 = 4.0;
/// ITU-R BS.1770-4 Annex 2 true-peak interpolator (4 phases × 12 taps). Also evaluated by the
/// detector so the output complies with the normative dBTP meter, whose passband ripple reads some
/// frequencies higher than an ideal interpolator would.
const BS1770: [[f64; 12]; 4] = [
    [
        0.0017089843750,
        0.0109863281250,
        -0.0196533203125,
        0.0332031250000,
        -0.0594482421875,
        0.1373291015625,
        0.9721679687500,
        -0.1022949218750,
        0.0476074218750,
        -0.0266113281250,
        0.0148925781250,
        -0.0083007812500,
    ],
    [
        -0.0291748046875,
        0.0292968750000,
        -0.0517578125000,
        0.0891113281250,
        -0.1665039062500,
        0.4650878906250,
        0.7797851562500,
        -0.2003173828125,
        0.1015625000000,
        -0.0582275390625,
        0.0330810546875,
        -0.0189208984375,
    ],
    [
        -0.0189208984375,
        0.0330810546875,
        -0.0582275390625,
        0.1015625000000,
        -0.2003173828125,
        0.7797851562500,
        0.4650878906250,
        -0.1665039062500,
        0.0891113281250,
        -0.0517578125000,
        0.0292968750000,
        -0.0291748046875,
    ],
    [
        -0.0083007812500,
        0.0148925781250,
        -0.0266113281250,
        0.0476074218750,
        -0.1022949218750,
        0.9721679687500,
        0.1373291015625,
        -0.0594482421875,
        0.0332031250000,
        -0.0196533203125,
        0.0109863281250,
        0.0017089843750,
    ],
];
/// Offset of the BS.1770 window inside the history window: taps 5/6 straddle `[m, m+1)`.
const BS1770_START: usize = HALF - 1 - 5;
/// Ceiling in dBTP.
pub const CEILING_DBTP: f64 = -1.0;
/// Internal safety margin (dB) for interpolator error.
const MARGIN_DB: f64 = 0.05;
pub const LOOKAHEAD_S: f64 = 0.002;
pub const RELEASE_S: f64 = 0.1;

/// Dot product with four independent accumulators (lets the compiler use SIMD; a plain iterator
/// sum is a serial dependency chain). `a.len()` must be a multiple of 4.
#[inline(always)]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut acc = [0.0f64; 4];
    for (ca, cb) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0.iter()) {
        acc[0] += ca[0] * cb[0];
        acc[1] += ca[1] * cb[1];
        acc[2] += ca[2] * cb[2];
        acc[3] += ca[3] * cb[3];
    }
    (acc[0] + acc[1]) + (acc[2] + acc[3])
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..64 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

/// Interpolation coefficients for the points `m + φ/4`, φ = 1…3, applied to `x[m−23 ..= m+24]`.
pub fn interpolator_phases() -> [[f64; TAPS]; 3] {
    let mut out = [[0.0; TAPS]; 3];
    let i0b = bessel_i0(KAISER_BETA);
    for (p, phase) in out.iter_mut().enumerate() {
        let frac = (p + 1) as f64 / 4.0;
        for (j, c) in phase.iter_mut().enumerate() {
            let d = frac + (HALF - 1) as f64 - j as f64; // t − i, in (−24, 24)
            let sinc = if d == 0.0 {
                1.0
            } else {
                (PI * d).sin() / (PI * d)
            };
            let r = d / HALF as f64;
            let w = bessel_i0(KAISER_BETA * (1.0 - r * r).max(0.0).sqrt()) / i0b;
            *c = sinc * w;
        }
        let sum: f64 = phase.iter().sum();
        phase.iter_mut().for_each(|c| *c /= sum);
    }
    out
}

pub struct TruePeakLimiter {
    ceiling: f64,
    window: usize,
    latency: usize,
    release: f64,
    phases: [[f64; TAPS]; 3],
    /// Last 16 input frames per channel, written twice so the window is always contiguous.
    hist: [[f64; 2 * TAPS]; 2],
    hpos: usize,
    prev_peak: f64,
    // Sliding-window minimum (monotonic deque in a ring).
    dq_val: Vec<f64>,
    dq_idx: Vec<u64>,
    dq_head: usize,
    dq_len: usize,
    n: u64,
    rel: f64,
    // Moving average.
    avg: Vec<f64>,
    avg_pos: usize,
    avg_sum: f64,
    // Audio delay line.
    delay: Vec<[f64; 2]>,
    dpos: usize,
}

impl TruePeakLimiter {
    pub fn new(sample_rate: f64) -> Self {
        let window = ((LOOKAHEAD_S * sample_rate).round() as usize).max(16);
        let latency = HALF + window - 1;
        let mut l = Self {
            ceiling: 10f64.powf((CEILING_DBTP - MARGIN_DB) / 20.0),
            window,
            latency,
            release: (-1.0 / (RELEASE_S * sample_rate)).exp(),
            phases: interpolator_phases(),
            hist: [[0.0; 2 * TAPS]; 2],
            hpos: 0,
            prev_peak: 0.0,
            dq_val: vec![0.0; window + 1],
            dq_idx: vec![0; window + 1],
            dq_head: 0,
            dq_len: 0,
            n: 0,
            rel: 1.0,
            avg: vec![1.0; window],
            avg_pos: 0,
            avg_sum: window as f64,
            delay: vec![[0.0; 2]; latency],
            dpos: 0,
        };
        l.reset();
        l
    }

    pub fn latency(&self) -> usize {
        self.latency
    }

    pub fn reset(&mut self) {
        self.hist = [[0.0; 2 * TAPS]; 2];
        self.hpos = 0;
        self.prev_peak = 0.0;
        self.dq_head = 0;
        self.dq_len = 0;
        self.n = 0;
        self.rel = 1.0;
        self.avg.fill(1.0);
        self.avg_pos = 0;
        self.avg_sum = self.window as f64;
        self.delay.fill([0.0; 2]);
        self.dpos = 0;
    }

    /// Sliding minimum over the last `window` values, including `v`.
    #[inline]
    fn push_min(&mut self, v: f64) -> f64 {
        let cap = self.dq_val.len();
        while self.dq_len > 0 {
            let back = (self.dq_head + self.dq_len - 1) % cap;
            if self.dq_val[back] >= v {
                self.dq_len -= 1;
            } else {
                break;
            }
        }
        let slot = (self.dq_head + self.dq_len) % cap;
        self.dq_val[slot] = v;
        self.dq_idx[slot] = self.n;
        self.dq_len += 1;
        let oldest_allowed = (self.n + 1).saturating_sub(self.window as u64);
        while self.dq_idx[self.dq_head] < oldest_allowed {
            self.dq_head = (self.dq_head + 1) % cap;
            self.dq_len -= 1;
        }
        self.n += 1;
        self.dq_val[self.dq_head]
    }

    /// 4× oversampled peak of the interval `[m, m+1)` for the frame 24 frames back.
    #[inline]
    fn detect(&mut self, x: [f64; 2]) -> f64 {
        let hp = self.hpos;
        let mut peak = 0.0f64;
        for (h, &xc) in self.hist.iter_mut().zip(&x) {
            h[hp] = xc;
            h[hp + TAPS] = xc;
            let w = &h[hp + 1..hp + 1 + TAPS];
            peak = peak.max(w[HALF - 1].abs());
            for ph in &self.phases {
                peak = peak.max(dot(ph, w).abs());
            }
            let wi = &w[BS1770_START..BS1770_START + 12];
            for ph in &BS1770 {
                peak = peak.max(dot(ph, wi).abs());
            }
        }
        self.hpos = (hp + 1) % TAPS;
        peak
    }

    #[inline]
    fn tick(&mut self, x: [f64; 2]) -> [f64; 2] {
        let peak = self.detect(x);
        let p2 = peak.max(self.prev_peak);
        self.prev_peak = peak;
        let required = if p2 > self.ceiling {
            self.ceiling / p2
        } else {
            1.0
        };
        let m = self.push_min(required);
        self.rel = if m <= self.rel {
            m
        } else {
            m + (self.rel - m) * self.release
        };
        let old = self.avg[self.avg_pos];
        self.avg[self.avg_pos] = self.rel;
        self.avg_sum += self.rel - old;
        self.avg_pos += 1;
        if self.avg_pos == self.window {
            self.avg_pos = 0;
            self.avg_sum = self.avg.iter().sum(); // resync: no drift
        }
        let gain = (self.avg_sum / self.window as f64).min(1.0);
        let d = self.delay[self.dpos];
        self.delay[self.dpos] = x;
        self.dpos += 1;
        if self.dpos == self.latency {
            self.dpos = 0;
        }
        [d[0] * gain, d[1] * gain]
    }

    pub fn process(&mut self, block: &mut [f64]) {
        for fr in block.as_chunks_mut::<2>().0.iter_mut() {
            let y = self.tick([fr[0], fr[1]]);
            fr[0] = y[0];
            fr[1] = y[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsp_interpolator_is_accurate_in_passband() {
        let ph = interpolator_phases();
        // A sine up to 0.45·fs must be reproduced within 0.06 dB at the interpolated points.
        for i in 1..=90 {
            let f = i as f64 * 0.005; // cycles/sample
            for (p, phase) in ph.iter().enumerate() {
                let t = 0.25 * (p + 1) as f64;
                let (mut re, mut im) = (0.0, 0.0);
                for (j, c) in phase.iter().enumerate() {
                    let n = j as f64 - (HALF - 1) as f64; // sample offset relative to m
                    let w = 2.0 * PI * f * (n - t);
                    re += c * w.cos();
                    im += c * w.sin();
                }
                let mag_db = 10.0 * (re * re + im * im).log10();
                assert!(mag_db.abs() < 0.06, "f={f} phase={p}: {mag_db} dB");
            }
        }
    }

    #[test]
    fn dsp_limiter_unity_below_ceiling() {
        let mut l = TruePeakLimiter::new(48_000.0);
        let lat = l.latency();
        let mut buf = vec![0.0; 2 * (lat + 10)];
        buf[0] = 0.5;
        buf[1] = -0.25;
        l.process(&mut buf);
        assert_eq!(buf[2 * lat], 0.5);
        assert_eq!(buf[2 * lat + 1], -0.25);
        assert_eq!(buf.iter().filter(|v| **v != 0.0).count(), 2);
    }
}

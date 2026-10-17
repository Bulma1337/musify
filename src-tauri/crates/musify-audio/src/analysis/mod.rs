//! Real-time spectrum analyzer for the EQ view.
//!
//! Contract: fed with mono samples at the device rate on the analyzer thread (never the audio
//! thread); `frame` returns log-spaced bands (20 Hz … 20 kHz) with attack/release smoothing and
//! peak hold, quantized to 0…255 for 0 = −90 dB … 255 = 0 dB.
//!
//! # Details
//!
//! * 4096-point real FFT (`realfft`), periodic Hann window, last 4096 mono samples kept in a ring
//!   (a frame every 2048 samples = 50 % overlap is the intended cadence, but `frame` may be called
//!   at any rate; the window is always the latest 4096 samples).
//! * Band level = power sum of the FFT bins whose centre lies in the band, normalised by the
//!   window coherent gain and equivalent noise bandwidth, so a full-scale sine reads ≈ 0 dB in
//!   its band. Bands containing no bin centre (low bands at high resolution) use the magnitude
//!   linearly interpolated between the two surrounding bins at the band centre. There is **no**
//!   pink/white weighting: white noise therefore rises ~3 dB/octave across the display (wider
//!   bands collect more bins), which matches a true power-per-band analyzer.
//! * Smoothing is done in the dB domain with time constants (attack 10 ms, release 280 ms), using
//!   the frame interval inferred from the number of samples pushed since the previous frame.
//! * Peak hold: per band, holds the smoothed maximum for 1 s then falls at 40 dB/s. It is kept
//!   internal because [`SpectrumFrame`] has no field for it; read it with
//!   [`SpectrumAnalyzer::peak_hold`].
//! * Allocation: `push` and `frame_into` never allocate after construction. `frame` returns an
//!   owned [`SpectrumFrame`], so it makes exactly one small `Vec<u8>` allocation per call (a clone
//!   of the preallocated output buffer); use `frame_into` to avoid even that.

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

use crate::api::SpectrumFrame;

/// FFT size (samples).
pub const FFT_SIZE: usize = 4096;
/// Lowest band edge in Hz.
pub const MIN_FREQ_HZ: f32 = 20.0;
/// Highest band edge in Hz (further limited to 0.45 · sample rate).
pub const MAX_FREQ_HZ: f32 = 20_000.0;

const DB_FLOOR: f32 = -90.0;
const POWER_FLOOR: f64 = 1e-9; // −90 dB
const ATTACK_S: f32 = 0.010;
const RELEASE_S: f32 = 0.280;
const PEAK_HOLD_S: f32 = 1.0;
const PEAK_FALL_DB_PER_S: f32 = 40.0;

/// How a band is computed from the FFT output.
#[derive(Clone, Copy, Debug)]
enum BandSource {
    /// Power sum of bins `start..end`.
    Bins { start: usize, end: usize },
    /// No bin centre inside the band: interpolate magnitude between `lo` and `lo + 1`.
    Interp { lo: usize, frac: f32 },
}

pub struct SpectrumAnalyzer {
    sample_rate: u32,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    /// Combined power normalisation (1 / (coherent_gain² · ENBW)).
    power_norm: f64,
    ring: Vec<f32>,
    ring_pos: usize,
    since_frame: u64,
    time_buf: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    edges: Vec<f32>,
    sources: Vec<BandSource>,
    smoothed_db: Vec<f32>,
    peak_db_bands: Vec<f32>,
    peak_hold_t: Vec<f32>,
    peak_q: Vec<u8>,
    out: Vec<u8>,
    primed: bool,
}

impl SpectrumAnalyzer {
    pub fn new(sample_rate: u32, bands: usize) -> Self {
        let bands = bands.max(1);
        let fs = sample_rate.max(8_000) as f32;

        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let spectrum = fft.make_output_vec();
        let fft_scratch = fft.make_scratch_vec();

        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|n| 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / FFT_SIZE as f64).cos() as f32)
            .collect();
        let sum_w: f64 = window.iter().map(|&w| w as f64).sum();
        let sum_w2: f64 = window.iter().map(|&w| (w as f64) * (w as f64)).sum();
        let coherent_gain = sum_w / 2.0; // peak |X| of a unit sine
        let enbw = FFT_SIZE as f64 * sum_w2 / (sum_w * sum_w); // 1.5 for Hann
        let power_norm = 1.0 / (coherent_gain * coherent_gain * enbw);

        let hi = MAX_FREQ_HZ.min(0.45 * fs).max(2.0 * MIN_FREQ_HZ);
        let ratio = (hi / MIN_FREQ_HZ).powf(1.0 / bands as f32);
        let mut edges: Vec<f32> = (0..=bands)
            .map(|i| MIN_FREQ_HZ * ratio.powi(i as i32))
            .collect();
        edges[0] = MIN_FREQ_HZ;
        edges[bands] = hi;

        let bin_hz = fs / FFT_SIZE as f32;
        let nbins = FFT_SIZE / 2 + 1;
        let sources = (0..bands)
            .map(|i| {
                let (lo_f, hi_f) = (edges[i], edges[i + 1]);
                // Bins whose centre k·bin_hz lies in [lo_f, hi_f).
                let start = (lo_f / bin_hz).ceil() as usize;
                let end = ((hi_f / bin_hz).ceil() as usize).min(nbins);
                if end > start {
                    BandSource::Bins { start, end }
                } else {
                    let centre = (lo_f * hi_f).sqrt() / bin_hz;
                    let lo = (centre.floor() as usize).min(nbins - 2);
                    BandSource::Interp {
                        lo,
                        frac: (centre - lo as f32).clamp(0.0, 1.0),
                    }
                }
            })
            .collect();

        Self {
            sample_rate,
            fft,
            window,
            power_norm,
            ring: vec![0.0; FFT_SIZE],
            ring_pos: 0,
            since_frame: 0,
            time_buf: vec![0.0; FFT_SIZE],
            spectrum,
            fft_scratch,
            edges,
            sources,
            smoothed_db: vec![DB_FLOOR; bands],
            peak_db_bands: vec![DB_FLOOR; bands],
            peak_hold_t: vec![0.0; bands],
            peak_q: vec![0; bands],
            out: vec![0; bands],
            primed: false,
        }
    }

    /// Number of bands.
    pub fn bands(&self) -> usize {
        self.sources.len()
    }

    /// Band edges in Hz (`bands + 1` strictly increasing values, 20 Hz … min(20 kHz, 0.45·fs)).
    pub fn band_edges(&self) -> &[f32] {
        &self.edges
    }

    /// Peak-hold values per band from the last `frame`, quantized like the frame bands.
    pub fn peak_hold(&self) -> &[u8] {
        &self.peak_q
    }

    /// Appends mono samples to the analysis window. Non-finite samples are treated as 0.
    /// Never allocates.
    pub fn push(&mut self, mono: &[f32]) {
        self.since_frame = self.since_frame.saturating_add(mono.len() as u64);
        // Only the last FFT_SIZE samples can survive in the ring.
        let tail = if mono.len() > FFT_SIZE {
            &mono[mono.len() - FFT_SIZE..]
        } else {
            mono
        };
        if mono.len() > FFT_SIZE {
            // Keep the write position consistent with a sample-by-sample push.
            self.ring_pos = (self.ring_pos + (mono.len() - tail.len())) % FFT_SIZE;
        }
        let mut pos = self.ring_pos;
        for &s in tail {
            self.ring[pos] = if s.is_finite() { s } else { 0.0 };
            pos += 1;
            if pos == FFT_SIZE {
                pos = 0;
            }
        }
        self.ring_pos = pos;
    }

    /// Computes the current frame (4096-point Hann FFT, 50 % overlap). `peak_db` is passed through.
    ///
    /// Allocates one small `Vec<u8>` (clone of the internal buffer); see [`Self::frame_into`].
    pub fn frame(&mut self, peak_db: f32) -> SpectrumFrame {
        self.compute();
        SpectrumFrame {
            bands: self.out.clone(),
            peak_db,
        }
    }

    /// Allocation-free variant of [`Self::frame`]: writes the quantized bands into `out`
    /// (cleared first; no allocation once it has capacity for `bands` values).
    pub fn frame_into(&mut self, out: &mut Vec<u8>) {
        self.compute();
        out.clear();
        out.extend_from_slice(&self.out);
    }

    fn compute(&mut self) {
        let fs = self.sample_rate.max(8_000) as f32;
        let dt = (self.since_frame as f32 / fs).min(10.0);
        self.since_frame = 0;

        // Window the latest samples, oldest first.
        let (newer, older) = self.ring.split_at(self.ring_pos);
        let ordered = older.iter().chain(newer.iter());
        for ((dst, &s), &w) in self.time_buf.iter_mut().zip(ordered).zip(&self.window) {
            *dst = s * w;
        }
        // Buffers are sized for this plan, so this cannot fail.
        let _ = self.fft.process_with_scratch(
            &mut self.time_buf,
            &mut self.spectrum,
            &mut self.fft_scratch,
        );

        let attack = 1.0 - (-dt / ATTACK_S).exp();
        let release = 1.0 - (-dt / RELEASE_S).exp();
        let spec = &self.spectrum;

        for (i, src) in self.sources.iter().enumerate() {
            let power = match *src {
                BandSource::Bins { start, end } => {
                    spec[start..end]
                        .iter()
                        .map(|c| (c.re as f64).powi(2) + (c.im as f64).powi(2))
                        .sum::<f64>()
                        * self.power_norm
                }
                BandSource::Interp { lo, frac } => {
                    let m0 = spec[lo].norm() as f64;
                    let m1 = spec[lo + 1].norm() as f64;
                    let m = m0 + (m1 - m0) * frac as f64;
                    m * m * self.power_norm
                }
            };
            let db = if power.is_finite() {
                (10.0 * power.max(POWER_FLOOR).log10()) as f32
            } else {
                0.0
            };
            let db = db.clamp(DB_FLOOR, 0.0);

            let s = &mut self.smoothed_db[i];
            if !self.primed {
                *s = db;
            } else {
                let k = if db > *s { attack } else { release };
                *s += (db - *s) * k;
            }
            let cur = *s;

            // Peak hold.
            let p = &mut self.peak_db_bands[i];
            let t = &mut self.peak_hold_t[i];
            if cur >= *p || !self.primed {
                *p = cur;
                *t = 0.0;
            } else {
                *t += dt;
                if *t > PEAK_HOLD_S {
                    *p = (*p - PEAK_FALL_DB_PER_S * dt).max(cur);
                }
            }

            self.out[i] = quantize(cur);
            self.peak_q[i] = quantize(*p);
        }
        self.primed = true;
    }
}

#[inline]
fn quantize(db: f32) -> u8 {
    (((db - DB_FLOOR) / -DB_FLOOR) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(fs: f32, f: f32, n: usize, start: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                (std::f64::consts::TAU * f as f64 * (start + i) as f64 / fs as f64).sin() as f32
            })
            .collect()
    }

    fn noise(n: usize, seed: u64) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((s >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
            })
            .collect()
    }

    fn band_of(a: &SpectrumAnalyzer, f: f32) -> usize {
        a.band_edges()
            .windows(2)
            .position(|w| f >= w[0] && f < w[1])
            .unwrap()
    }

    fn run_sine(bands: usize) -> (SpectrumAnalyzer, SpectrumFrame) {
        let mut a = SpectrumAnalyzer::new(48_000, bands);
        let x = sine(48_000.0, 1000.0, 48_000, 0);
        let mut f = None;
        for c in x.chunks(2048) {
            a.push(c);
            f = Some(a.frame(-3.0));
        }
        (a, f.unwrap())
    }

    #[test]
    fn sine_peaks_in_right_band() {
        for bands in [32, 64, 128] {
            let (a, f) = run_sine(bands);
            let b = band_of(&a, 1000.0);
            let max = f
                .bands
                .iter()
                .enumerate()
                .max_by_key(|(_, v)| **v)
                .unwrap()
                .0;
            assert!(max.abs_diff(b) <= 1, "bands={bands} max={max} expected={b}");
            assert!(f.bands[max] >= 250, "bands={bands} level {}", f.bands[max]);
            assert_eq!(f.peak_db, -3.0);
            // Bands >= 2 away are at least 40 dB lower (40 dB = 113 quantization steps).
            let peak = f.bands[max] as i32;
            for (i, &v) in f.bands.iter().enumerate() {
                if i.abs_diff(max) >= 2 {
                    assert!(
                        peak - v as i32 >= 113,
                        "bands={bands} band {i} = {v}, peak {peak}"
                    );
                }
            }
        }
    }

    #[test]
    fn silence_is_zero() {
        let mut a = SpectrumAnalyzer::new(48_000, 64);
        a.push(&vec![0.0; 10_000]);
        let f = a.frame(-120.0);
        assert_eq!(f.bands.len(), 64);
        assert!(f.bands.iter().all(|&v| v == 0));
    }

    #[test]
    fn white_noise_bounded_spread() {
        let mut a = SpectrumAnalyzer::new(48_000, 64);
        let x = noise(48_000, 1);
        let mut f = None;
        for c in x.chunks(2048) {
            a.push(c);
            f = Some(a.frame(0.0));
        }
        let f = f.unwrap();
        assert!(f.bands.iter().all(|&v| v > 0));
        // No weighting: true power per band rises ~3 dB/oct (~30 dB across 10 octaves); keep a
        // generous bound on the dB spread (90 dB = 255 steps).
        let (mn, mx) = (
            *f.bands.iter().min().unwrap(),
            *f.bands.iter().max().unwrap(),
        );
        assert!((mx - mn) as f32 / 255.0 * 90.0 < 50.0, "spread {mn}..{mx}");
    }

    #[test]
    fn edges_cover_range() {
        for bands in [32, 64, 128] {
            let a = SpectrumAnalyzer::new(48_000, bands);
            let e = a.band_edges();
            assert_eq!(e.len(), bands + 1);
            assert_eq!(e[0], 20.0);
            assert_eq!(e[bands], 20_000.0);
            assert!(e.windows(2).all(|w| w[1] > w[0]));
        }
        for fs in [44_100u32, 96_000, 192_000, 384_000] {
            let a = SpectrumAnalyzer::new(fs, 64);
            let e = a.band_edges();
            assert!(e.windows(2).all(|w| w[1] > w[0]));
            assert!(e[64] <= 0.45 * fs as f32 + 1.0 && e[64] <= 20_000.0);
            let mut a = a;
            a.push(&noise(5000, 3));
            assert!(a.frame(0.0).bands.iter().all(|&v| v > 0), "fs={fs}");
        }
    }

    #[test]
    fn release_decays_gradually() {
        let mut a = SpectrumAnalyzer::new(48_000, 64);
        for c in sine(48_000.0, 1000.0, 24_000, 0).chunks(2048) {
            a.push(c);
            a.frame(0.0);
        }
        let b = band_of(&a, 1000.0);
        let loud = a.frame(0.0).bands[b];
        let mut prev = loud;
        let mut vals = vec![];
        for _ in 0..10 {
            a.push(&[0.0; 2048]);
            let v = a.frame(0.0).bands[b];
            assert!(v <= prev);
            vals.push(v);
            prev = v;
        }
        assert!(loud >= 250);
        assert!(vals[0] > 150, "instant drop: {vals:?}");
        assert!(vals[9] < vals[0] - 30, "no decay: {vals:?}");
        assert!(
            a.peak_hold()[b] > vals[9],
            "peak hold should outlast smoothing"
        );
    }

    #[test]
    fn chunking_is_irrelevant() {
        let x: Vec<f32> = noise(20_000, 9)
            .iter()
            .zip(sine(48_000.0, 440.0, 20_000, 0))
            .map(|(n, s)| n * 0.2 + s * 0.5)
            .collect();
        let mut one = SpectrumAnalyzer::new(48_000, 64);
        one.push(&x);
        let r1 = one.frame(0.0);
        let mut tiny = SpectrumAnalyzer::new(48_000, 64);
        for c in x.chunks(7) {
            tiny.push(c);
        }
        assert_eq!(r1, tiny.frame(0.0));
        let mut mixed = SpectrumAnalyzer::new(48_000, 64);
        mixed.push(&x[..3]);
        mixed.push(&x[3..15_000]);
        mixed.push(&x[15_000..]);
        assert_eq!(r1, mixed.frame(0.0));
    }

    #[test]
    fn nan_inf_treated_as_zero() {
        let mut a = SpectrumAnalyzer::new(48_000, 64);
        a.push(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e30]);
        a.push(&vec![f32::NAN; 5000]);
        let f = a.frame(0.0);
        assert_eq!(f.bands.len(), 64);
    }

    #[test]
    fn frame_into_matches_frame() {
        let mut a = SpectrumAnalyzer::new(48_000, 32);
        let mut b = SpectrumAnalyzer::new(48_000, 32);
        let x = sine(48_000.0, 3000.0, 5000, 0);
        a.push(&x);
        b.push(&x);
        let mut out = Vec::with_capacity(32);
        b.frame_into(&mut out);
        assert_eq!(a.frame(0.0).bands, out);
    }
}

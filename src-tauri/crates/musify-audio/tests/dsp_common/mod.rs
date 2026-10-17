//! Measurement helpers shared by the `dsp_*` integration tests.
#![allow(dead_code)]

use std::f64::consts::PI;

use musify_audio::api::{DspConfig, EqConfig, EqMode, FilterKind, GraphicBands, ParametricFilter};
use musify_audio::dsp::DspChain;
use musify_audio::dsp::biquad::{Coeffs, StereoState, process_stereo};

/// xorshift64* — deterministic test randomness.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    pub fn gauss(&mut self) -> f64 {
        let u = self.unit().max(1e-300);
        let v = self.unit();
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * v).cos()
    }
}

pub fn db(x: f64) -> f64 {
    20.0 * x.abs().max(1e-300).log10()
}

pub fn graphic(bands: GraphicBands, gains_db: Vec<f64>) -> DspConfig {
    DspConfig {
        eq: EqConfig {
            enabled: true,
            preamp_db: 0.0,
            auto_headroom: false,
            mode: EqMode::Graphic { bands, gains_db },
        },
        ..DspConfig::default()
    }
}

pub fn pf(kind: FilterKind, freq_hz: f64, gain_db: f64, q: f64) -> ParametricFilter {
    ParametricFilter {
        enabled: true,
        kind,
        freq_hz,
        gain_db,
        q,
    }
}

pub fn parametric(
    filters: Vec<ParametricFilter>,
    preamp_db: f64,
    auto_headroom: bool,
) -> DspConfig {
    DspConfig {
        eq: EqConfig {
            enabled: true,
            preamp_db,
            auto_headroom,
            mode: EqMode::Parametric { filters },
        },
        ..DspConfig::default()
    }
}

/// Runs silence until every glide and crossfade has finished.
pub fn settle(chain: &mut DspChain, seconds: f64) {
    let frames = (seconds * chain.sample_rate() as f64) as usize;
    let mut buf = vec![0.0; 2 * 512];
    let mut done = 0;
    while done < frames {
        chain.process(&mut buf);
        buf.fill(0.0);
        done += 512;
    }
}

/// Left-channel impulse response of the running chain (impulse of height `amp`), processed in
/// 512-frame blocks.
pub fn impulse_response(chain: &mut DspChain, len: usize, amp: f64) -> Vec<f64> {
    let mut buf = vec![0.0; 2 * len];
    buf[0] = amp;
    buf[1] = amp;
    for block in buf.chunks_mut(1024) {
        chain.process(block);
    }
    buf.as_chunks::<2>().0.iter().map(|f| f[0] / amp).collect()
}

/// Magnitude (dB) of the DTFT of `x` at `f`.
pub fn dtft_db(x: &[f64], fs: f64, f: f64) -> f64 {
    let w = 2.0 * PI * f / fs;
    // Recurrence-free but accurate: rotate a phasor and renormalize occasionally.
    let (s, c) = w.sin_cos();
    let (mut pr, mut pi) = (1.0f64, 0.0f64);
    let (mut re, mut im) = (0.0, 0.0);
    for (n, &v) in x.iter().enumerate() {
        re += v * pr;
        im -= v * pi;
        let nr = pr * c - pi * s;
        pi = pr * s + pi * c;
        pr = nr;
        if n % 1024 == 1023 {
            let (sn, cn) = (w * (n + 1) as f64).sin_cos();
            pr = cn;
            pi = sn;
        }
    }
    10.0 * (re * re + im * im).max(1e-300).log10()
}

/// Reference 4× oversampled true-peak meter (128-tap-per-phase Kaiser-windowed sinc), in dBTP.
pub fn true_peak_db(x: &[f64]) -> f64 {
    true_peak_db_with(x, 64, 8.0)
}

pub fn true_peak_db_with(x: &[f64], half: usize, beta: f64) -> f64 {
    let half = half as isize;
    #[allow(non_snake_case)]
    let HALF = half;
    let i0 = |x: f64| {
        let (mut s, mut t) = (1.0, 1.0);
        for k in 1..80 {
            t *= x * x / 4.0 / (k * k) as f64;
            s += t;
        }
        s
    };
    let i0b = i0(beta);
    let mut phases = vec![vec![0.0; 2 * HALF as usize]; 3];
    for (p, ph) in phases.iter_mut().enumerate() {
        let frac = (p + 1) as f64 / 4.0;
        for (j, c) in ph.iter_mut().enumerate() {
            let d = frac + (HALF - 1) as f64 - j as f64;
            let sinc = if d == 0.0 {
                1.0
            } else {
                (PI * d).sin() / (PI * d)
            };
            let r = d / HALF as f64;
            *c = sinc * i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b;
        }
    }
    let mut peak = x.iter().fold(0.0f64, |p, v| p.max(v.abs()));
    let n = x.len() as isize;
    for m in 0..n {
        for ph in &phases {
            let mut s = 0.0;
            for (j, c) in ph.iter().enumerate() {
                let i = m - (HALF - 1) + j as isize;
                if i >= 0 && i < n {
                    s += c * x[i as usize];
                }
            }
            peak = peak.max(s.abs());
        }
    }
    db(peak)
}

/// 4× true-peak meter with the interpolation filter of ITU-R BS.1770-4 Annex 2 (48 taps, 12 per
/// phase) — the normative definition of dBTP.
pub fn true_peak_bs1770_db(x: &[f64]) -> f64 {
    const PHASES: [[f64; 12]; 4] = [
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
    let mut peak = x.iter().fold(0.0f64, |p, v| p.max(v.abs()));
    for m in 0..x.len() {
        for ph in &PHASES {
            let mut s = 0.0;
            for (j, c) in ph.iter().enumerate() {
                if let Some(v) = (m + j).checked_sub(11).and_then(|i| x.get(i)) {
                    s += c * v;
                }
            }
            peak = peak.max(s.abs());
        }
    }
    db(peak)
}

/// White noise low-passed at `cutoff`·fs (255-tap Kaiser-windowed sinc), i.e. like real program
/// material that went through an anti-aliasing filter.
pub fn bandlimited_noise(rng: &mut Rng, frames: usize, cutoff: f64) -> Vec<f64> {
    const HALF: isize = 127;
    let beta = 10.0;
    let i0 = |x: f64| {
        let (mut s, mut t) = (1.0, 1.0);
        for k in 1..80 {
            t *= x * x / 4.0 / (k * k) as f64;
            s += t;
        }
        s
    };
    let h: Vec<f64> = (-HALF..=HALF)
        .map(|k| {
            let d = k as f64;
            let sinc = if k == 0 {
                2.0 * cutoff
            } else {
                (2.0 * PI * cutoff * d).sin() / (PI * d)
            };
            let r = d / HALF as f64;
            sinc * i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0(beta)
        })
        .collect();
    let white: Vec<f64> = (0..frames + h.len())
        .map(|_| rng.range(-1.0, 1.0))
        .collect();
    let y: Vec<f64> = (0..frames)
        .map(|n| h.iter().zip(&white[n..]).map(|(a, b)| a * b).sum())
        .collect();
    let peak = y.iter().fold(0.0f64, |p, v| p.max(v.abs()));
    y.into_iter().map(|v| v / peak).collect()
}

pub fn channel(buf: &[f64], ch: usize) -> Vec<f64> {
    buf.as_chunks::<2>().0.iter().map(|f| f[ch]).collect()
}

/// 12th-order Butterworth high-pass applied to an interleaved buffer (both channels).
pub fn highpass12(buf: &[f64], fc: f64, fs: f64) -> Vec<f64> {
    let mut out = buf.to_vec();
    for k in 1..=6 {
        let q = 1.0 / (2.0 * ((2 * k - 1) as f64 * PI / 24.0).cos());
        let c = Coeffs::design(FilterKind::HighPass, fc, 0.0, q, fs);
        let mut st = StereoState::default();
        process_stereo(&c, &mut st, &mut out);
    }
    out
}

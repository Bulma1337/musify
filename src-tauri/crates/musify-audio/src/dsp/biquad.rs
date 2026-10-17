//! Second-order IIR sections: RBJ Audio-EQ-Cookbook design, magnitude-matched peaking design,
//! exact magnitude evaluation and Transposed Direct Form II processing.
//!
//! Design notes:
//! - [`Design::Bilinear`] filters are the bilinear transform (prewarped at `f0`) of the cookbook's
//!   analog prototype, so the digital magnitude at `w` equals the analog magnitude at
//!   `Ω = tan(w/2) / tan(w0/2)`. This is what AutoEQ / Equalizer APO profiles assume, so parametric
//!   filters always use it. Its drawback is frequency warping: near Nyquist every bell is squeezed
//!   (a 16 kHz octave band at 44.1 kHz loses about half of its upper skirt).
//! - [`Design::Matched`] (peaking only) follows M. Vicanek, "Matched Second Order Digital Filters"
//!   (2016): impulse-invariant poles, and a numerator chosen so that `|H|` equals the analog
//!   prototype exactly at DC, at `f0` and at Nyquist. There is no warping: the bell keeps its analog
//!   width up to Nyquist. A cut is designed as the exact inverse of the matching boost, so boost and
//!   cut stay mirror images (as in the analog prototype) and the cut's poles are the boost's
//!   minimum-phase zeros. The graphic EQ uses it (see `eq/graphic.rs`).
//! - Shelves use the cookbook's **Q form** (`alpha = sin(w0) / (2Q)`), not the slope `S` form,
//!   because AutoEQ / Equalizer APO profiles specify shelves with Q. `Q = 1/√2` equals `S = 1`
//!   (steepest slope without overshoot) and is what the internal shelves (bass, loudness) use.
//! - `1 − cos(w0)` is computed as `2·sin²(w0/2)` to keep low-frequency filters accurate at high
//!   sample rates (e.g. 20 Hz at 384 kHz).

use std::f64::consts::{PI, TAU};

use crate::api::FilterKind;

/// Highest usable center/corner frequency relative to the sample rate.
pub const MAX_FREQ_RATIO: f64 = 0.49;
/// Lowest usable center/corner frequency.
pub const MIN_FREQ_HZ: f64 = 2.0;
pub const MIN_Q: f64 = 0.025;
pub const MAX_Q: f64 = 100.0;
/// Hard safety limit for a single filter's gain.
pub const MAX_GAIN_DB: f64 = 48.0;
/// Q of a 2nd-order Butterworth section.
pub const BUTTERWORTH_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Normalized biquad coefficients (`a0 = 1`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

/// How the analog prototype of a filter is turned into a digital biquad.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Design {
    /// RBJ cookbook (bilinear transform, prewarped at `f0`).
    #[default]
    Bilinear,
    /// Magnitude-matched, warping-free design. Only peaking filters have one; other kinds fall back
    /// to [`Design::Bilinear`].
    Matched,
}

/// One filter of a chain, in user units. Gain is ignored (forced to 0) for pass and notch filters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FilterSpec {
    pub kind: FilterKind,
    pub freq_hz: f64,
    pub gain_db: f64,
    pub q: f64,
    pub design: Design,
}

impl FilterSpec {
    /// An RBJ (bilinear) filter.
    pub fn new(kind: FilterKind, freq_hz: f64, gain_db: f64, q: f64) -> Self {
        Self {
            kind,
            freq_hz,
            gain_db,
            q,
            design: Design::Bilinear,
        }
    }

    /// A magnitude-matched peaking filter (see [`Design::Matched`]).
    pub fn matched_peaking(freq_hz: f64, gain_db: f64, q: f64) -> Self {
        Self {
            design: Design::Matched,
            ..Self::new(FilterKind::Peaking, freq_hz, gain_db, q)
        }
    }

    /// Same filter kind and design: changing between the two only needs parameter smoothing.
    pub fn same_shape(&self, other: &FilterSpec) -> bool {
        self.kind == other.kind && self.design == other.design
    }

    /// Parameters clamped to what the filter design accepts at `sample_rate`.
    pub fn clamped(self, sample_rate: f64) -> Self {
        let max_f = (MAX_FREQ_RATIO * sample_rate).max(MIN_FREQ_HZ);
        let freq_hz = if self.freq_hz.is_finite() {
            self.freq_hz.clamp(MIN_FREQ_HZ, max_f)
        } else {
            1000.0f64.min(max_f)
        };
        let q = if self.q.is_finite() && self.q > 0.0 {
            self.q.clamp(MIN_Q, MAX_Q)
        } else {
            BUTTERWORTH_Q
        };
        let gain_db = if has_gain(self.kind) && self.gain_db.is_finite() {
            self.gain_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB)
        } else {
            0.0
        };
        Self {
            kind: self.kind,
            freq_hz,
            gain_db,
            q,
            design: self.design,
        }
    }

    /// Coefficients at `sample_rate` (parameters are clamped).
    pub fn coeffs(&self, sample_rate: f64) -> Coeffs {
        match (self.design, self.kind) {
            (Design::Matched, FilterKind::Peaking) => {
                Coeffs::matched_peaking(self.freq_hz, self.gain_db, self.q, sample_rate)
            }
            _ => Coeffs::design(self.kind, self.freq_hz, self.gain_db, self.q, sample_rate),
        }
    }
}

fn valid_rate(sample_rate: f64) -> f64 {
    if sample_rate.is_finite() && sample_rate > 0.0 {
        sample_rate
    } else {
        48_000.0
    }
}

/// `|H(jΩ)|²` of the cookbook's analog peaking prototype `(s² + s·A/Q + 1) / (s² + s/(A·Q) + 1)` at
/// `Ω² = omega_sq` (frequency normalized to `f0`), with `a = A = 10^(gain/40)`.
pub fn analog_peaking_mag_sq(omega_sq: f64, a: f64, q: f64) -> f64 {
    let re = (1.0 - omega_sq) * (1.0 - omega_sq);
    (re + omega_sq * (a / q) * (a / q)) / (re + omega_sq / ((a * q) * (a * q)))
}

/// `(b0, b1, b2)` of the minimum-phase polynomial whose squared magnitude is
/// `dc·cos²(w/2) + ny·sin²(w/2) + x·cos²(w/2)·sin²(w/2)`. A slightly infeasible `x` (rounding) is
/// limited to the realizable range.
fn factor_magnitude(dc: f64, ny: f64, x: f64) -> (f64, f64, f64) {
    let p = dc.max(0.0).sqrt(); // b0 + b1 + b2
    let m = ny.max(0.0).sqrt(); // b0 − b1 + b2
    let w = 0.5 * (p + m); // b0 + b2
    let d = (w * w + 0.25 * x).max(0.0).sqrt(); // b0 − b2 (b0·b2 = −x/16)
    (0.5 * (w + d), 0.5 * (p - m), 0.5 * (w - d))
}

/// Whether `kind` uses its gain parameter.
pub fn has_gain(kind: FilterKind) -> bool {
    matches!(
        kind,
        FilterKind::Peaking | FilterKind::LowShelf | FilterKind::HighShelf
    )
}

impl Coeffs {
    pub const IDENTITY: Coeffs = Coeffs {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    /// RBJ cookbook design. Parameters are clamped (see [`FilterSpec::clamped`]).
    pub fn design(
        kind: FilterKind,
        freq_hz: f64,
        gain_db: f64,
        q: f64,
        sample_rate: f64,
    ) -> Coeffs {
        let fs = valid_rate(sample_rate);
        let s = FilterSpec::new(kind, freq_hz, gain_db, q).clamped(fs);
        let w0 = TAU * s.freq_hz / fs;
        let sin_w = w0.sin();
        let half = (0.5 * w0).sin();
        let omc = 2.0 * half * half; // 1 − cos(w0), accurate for small w0
        let cos_w = 1.0 - omc;
        let alpha = sin_w / (2.0 * s.q);
        let a = 10f64.powf(s.gain_db / 40.0);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::Peaking => (
                1.0 + alpha * a,
                -2.0 * cos_w,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w,
                1.0 - alpha / a,
            ),
            FilterKind::LowShelf => {
                let sq = 2.0 * a.sqrt() * alpha;
                (
                    a * (2.0 + (a - 1.0) * omc + sq),
                    2.0 * a * (-2.0 + (a + 1.0) * omc),
                    a * (2.0 + (a - 1.0) * omc - sq),
                    2.0 * a - (a - 1.0) * omc + sq,
                    -2.0 * (2.0 * a - (a + 1.0) * omc),
                    2.0 * a - (a - 1.0) * omc - sq,
                )
            }
            FilterKind::HighShelf => {
                let sq = 2.0 * a.sqrt() * alpha;
                (
                    a * (2.0 * a - (a - 1.0) * omc + sq),
                    -2.0 * a * (2.0 * a - (a + 1.0) * omc),
                    a * (2.0 * a - (a - 1.0) * omc - sq),
                    2.0 + (a - 1.0) * omc + sq,
                    2.0 * (-2.0 + (a + 1.0) * omc),
                    2.0 + (a - 1.0) * omc - sq,
                )
            }
            FilterKind::LowPass => (
                0.5 * omc,
                omc,
                0.5 * omc,
                1.0 + alpha,
                -2.0 * cos_w,
                1.0 - alpha,
            ),
            FilterKind::HighPass => {
                let opc = 2.0 - omc; // 1 + cos(w0)
                (
                    0.5 * opc,
                    -opc,
                    0.5 * opc,
                    1.0 + alpha,
                    -2.0 * cos_w,
                    1.0 - alpha,
                )
            }
            FilterKind::Notch => (
                1.0,
                -2.0 * cos_w,
                1.0,
                1.0 + alpha,
                -2.0 * cos_w,
                1.0 - alpha,
            ),
        };
        let inv = 1.0 / a0;
        Coeffs {
            b0: b0 * inv,
            b1: b1 * inv,
            b2: b2 * inv,
            a1: a1 * inv,
            a2: a2 * inv,
        }
    }

    /// Magnitude-matched peaking filter (Vicanek 2016, see the module docs). Parameters are clamped
    /// like in [`Coeffs::design`].
    pub fn matched_peaking(freq_hz: f64, gain_db: f64, q: f64, sample_rate: f64) -> Coeffs {
        let fs = valid_rate(sample_rate);
        let s = FilterSpec::new(FilterKind::Peaking, freq_hz, gain_db, q).clamped(fs);
        let w0 = TAU * s.freq_hz / fs;
        // Design the boost; a cut is its exact inverse.
        let a = 10f64.powf(s.gain_db.abs() / 40.0);
        // Poles of 1 / (s² + s/(A·Q) + 1), mapped by impulse invariance (z = e^{sT}).
        let zeta = 1.0 / (2.0 * a * s.q);
        let r = (-zeta * w0).exp();
        let a1 = if zeta <= 1.0 {
            -2.0 * r * (w0 * (1.0 - zeta * zeta).sqrt()).cos()
        } else {
            -2.0 * r * (w0 * (zeta * zeta - 1.0).sqrt()).cosh()
        };
        let a2 = r * r;
        if s.gain_db == 0.0 {
            // Numerator = denominator: exactly unity gain.
            return Coeffs {
                b0: 1.0,
                b1: a1,
                b2: a2,
                a1,
                a2,
            };
        }
        // |A(w)|² = A0·φ0 + A1·φ1 + A2·φ0·φ1 with φ0 = cos²(w/2), φ1 = sin²(w/2).
        let den_dc = (1.0 + a1 + a2) * (1.0 + a1 + a2);
        let den_ny = (1.0 - a1 + a2) * (1.0 - a1 + a2);
        let den_x = -16.0 * a2;
        let half = (0.5 * w0).sin();
        let phi1 = half * half;
        let phi0 = 1.0 - phi1;
        let g2 = a * a * a * a; // analog |H(f0)|²
        let omega_ny = 0.5 * fs / s.freq_hz;
        let ny2 = analog_peaking_mag_sq(omega_ny * omega_ny, a, s.q); // analog |H(fs/2)|²
        // Numerator |B|² = B0·φ0 + B1·φ1 + B2·φ0·φ1 with |H|² = 1 at DC, ny2 at Nyquist and g2 at
        // f0. B2 is written without the large cancelling terms of the direct solution.
        let num_dc = den_dc;
        let num_ny = den_ny * ny2;
        let num_x = (g2 - 1.0) * den_dc / phi1 + (g2 - ny2) * den_ny / phi0 + g2 * den_x;
        let (b0, b1, b2) = factor_magnitude(num_dc, num_ny, num_x);
        if s.gain_db > 0.0 {
            Coeffs { b0, b1, b2, a1, a2 }
        } else {
            let inv = 1.0 / b0;
            Coeffs {
                b0: inv,
                b1: a1 * inv,
                b2: a2 * inv,
                a1: b1 * inv,
                a2: b2 * inv,
            }
        }
    }

    /// Linear interpolation between two coefficient sets. The stability region of `(a1, a2)` is a
    /// triangle (convex), so interpolating between two stable filters is always stable.
    #[inline]
    pub fn lerp(a: &Coeffs, b: &Coeffs, t: f64) -> Coeffs {
        Coeffs {
            b0: a.b0 + (b.b0 - a.b0) * t,
            b1: a.b1 + (b.b1 - a.b1) * t,
            b2: a.b2 + (b.b2 - a.b2) * t,
            a1: a.a1 + (b.a1 - a.a1) * t,
            a2: a.a2 + (b.a2 - a.a2) * t,
        }
    }

    /// Squared magnitude at `freq_hz`, using the cookbook's numerically robust `φ = sin²(w/2)` form.
    pub fn magnitude_sq(&self, freq_hz: f64, sample_rate: f64) -> f64 {
        self.magnitude_sq_phi(phi(freq_hz, sample_rate))
    }

    /// Squared magnitude at `φ = sin²(w/2)` (see [`phi`]).
    #[inline]
    pub fn magnitude_sq_phi(&self, phi: f64) -> f64 {
        let Coeffs { b0, b1, b2, a1, a2 } = *self;
        let bs = b0 + b1 + b2;
        let as_ = 1.0 + a1 + a2;
        let num =
            bs * bs - 4.0 * (b0 * b1 + 4.0 * b0 * b2 + b1 * b2) * phi + 16.0 * b0 * b2 * phi * phi;
        let den = as_ * as_ - 4.0 * (a1 + 4.0 * a2 + a1 * a2) * phi + 16.0 * a2 * phi * phi;
        num.max(1e-300) / den.max(1e-300)
    }

    /// Magnitude in dB at `freq_hz` (≥ −3000 dB for exact zeros).
    pub fn magnitude_db(&self, freq_hz: f64, sample_rate: f64) -> f64 {
        10.0 * self.magnitude_sq(freq_hz, sample_rate).log10()
    }

    /// Complex response `H(e^{jw})` as `(re, im)` (reference implementation for tests).
    pub fn response(&self, freq_hz: f64, sample_rate: f64) -> (f64, f64) {
        let w = TAU * freq_hz / sample_rate;
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        // z^-1 = c1 − j s1, z^-2 = c2 − j s2
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        let d = dr * dr + di * di;
        ((nr * dr + ni * di) / d, (ni * dr - nr * di) / d)
    }
}

/// `φ = sin²(π·f/fs)`, the frequency variable of [`Coeffs::magnitude_sq_phi`].
#[inline]
pub fn phi(freq_hz: f64, sample_rate: f64) -> f64 {
    let s = (PI * freq_hz / sample_rate).sin();
    s * s
}

/// Values below this are flushed to zero (−600 dBFS): keeps the state out of the denormal range.
const DENORMAL_FLUSH: f64 = 1e-30;

#[inline]
fn flush(v: &mut f64) -> bool {
    if !v.is_finite() {
        return false;
    }
    if v.abs() < DENORMAL_FLUSH {
        *v = 0.0;
    }
    true
}

/// TDF-II state for an interleaved stereo pair.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StereoState {
    s1: [f64; 2],
    s2: [f64; 2],
}

impl StereoState {
    /// Flushes denormal-range values and clears the state if it became non-finite. Called once per
    /// 32-frame chunk.
    #[inline]
    pub fn sanitize(&mut self) {
        let ok = flush(&mut self.s1[0])
            & flush(&mut self.s1[1])
            & flush(&mut self.s2[0])
            & flush(&mut self.s2[1]);
        if !ok {
            *self = Self::default();
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Filters interleaved stereo `buf` in place (Transposed Direct Form II).
#[inline]
pub fn process_stereo(c: &Coeffs, st: &mut StereoState, buf: &mut [f64]) {
    let Coeffs { b0, b1, b2, a1, a2 } = *c;
    let [mut s1l, mut s1r] = st.s1;
    let [mut s2l, mut s2r] = st.s2;
    for fr in buf.as_chunks_mut::<2>().0.iter_mut() {
        let xl = fr[0];
        let xr = fr[1];
        let yl = b0 * xl + s1l;
        let yr = b0 * xr + s1r;
        s1l = b1 * xl - a1 * yl + s2l;
        s1r = b1 * xr - a1 * yr + s2r;
        s2l = b2 * xl - a2 * yl;
        s2r = b2 * xr - a2 * yr;
        fr[0] = yl;
        fr[1] = yr;
    }
    st.s1 = [s1l, s1r];
    st.s2 = [s2l, s2r];
}

/// Like [`process_stereo`], but the coefficients move linearly from `c0` to `c1`: frame `i` of
/// `buf` uses `lerp(c0, c1, (first + i) * step)`.
#[inline]
pub fn process_stereo_ramp(
    c0: &Coeffs,
    c1: &Coeffs,
    first: usize,
    step: f64,
    st: &mut StereoState,
    buf: &mut [f64],
) {
    let [mut s1l, mut s1r] = st.s1;
    let [mut s2l, mut s2r] = st.s2;
    for (i, fr) in buf.as_chunks_mut::<2>().0.iter_mut().enumerate() {
        let Coeffs { b0, b1, b2, a1, a2 } = Coeffs::lerp(c0, c1, (first + i) as f64 * step);
        let xl = fr[0];
        let xr = fr[1];
        let yl = b0 * xl + s1l;
        let yr = b0 * xr + s1r;
        s1l = b1 * xl - a1 * yl + s2l;
        s1r = b1 * xr - a1 * yr + s2r;
        s2l = b2 * xl - a2 * yl;
        s2r = b2 * xr - a2 * yr;
        fr[0] = yl;
        fr[1] = yr;
    }
    st.s1 = [s1l, s1r];
    st.s2 = [s2l, s2r];
}

/// TDF-II state for a single channel.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MonoState {
    s1: f64,
    s2: f64,
}

impl MonoState {
    #[inline]
    pub fn tick(&mut self, c: &Coeffs, x: f64) -> f64 {
        let y = c.b0 * x + self.s1;
        self.s1 = c.b1 * x - c.a1 * y + self.s2;
        self.s2 = c.b2 * x - c.a2 * y;
        y
    }

    #[inline]
    pub fn sanitize(&mut self) {
        let ok = flush(&mut self.s1) & flush(&mut self.s2);
        if !ok {
            *self = Self::default();
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [FilterKind; 6] = [
        FilterKind::Peaking,
        FilterKind::LowShelf,
        FilterKind::HighShelf,
        FilterKind::LowPass,
        FilterKind::HighPass,
        FilterKind::Notch,
    ];

    /// |H(jΩ)|² of the cookbook's analog prototypes (Ω normalized to the center/corner frequency).
    fn analog_mag_sq(kind: FilterKind, omega: f64, gain_db: f64, q: f64) -> f64 {
        let a = 10f64.powf(gain_db / 40.0);
        let o2 = omega * omega;
        match kind {
            FilterKind::Peaking => {
                let re = (1.0 - o2).powi(2);
                (re + (omega * a / q).powi(2)) / (re + (omega / (a * q)).powi(2))
            }
            FilterKind::LowShelf => {
                let k = (omega * a.sqrt() / q).powi(2);
                a * a * ((a - o2).powi(2) + k) / ((1.0 - a * o2).powi(2) + k)
            }
            FilterKind::HighShelf => {
                let k = (omega * a.sqrt() / q).powi(2);
                a * a * ((1.0 - a * o2).powi(2) + k) / ((a - o2).powi(2) + k)
            }
            FilterKind::LowPass => 1.0 / ((1.0 - o2).powi(2) + (omega / q).powi(2)),
            FilterKind::HighPass => o2 * o2 / ((1.0 - o2).powi(2) + (omega / q).powi(2)),
            FilterKind::Notch => (1.0 - o2).powi(2) / ((1.0 - o2).powi(2) + (omega / q).powi(2)),
        }
    }

    fn db(x: f64) -> f64 {
        10.0 * x.max(1e-300).log10()
    }

    #[test]
    fn dsp_biquad_matches_analytic_rbj_prototype() {
        let mut worst = 0.0f64;
        for &fs in &[44_100.0, 48_000.0, 96_000.0, 192_000.0, 384_000.0] {
            for kind in KINDS {
                for &(f0, g, q) in &[
                    (31.5, 12.0, 0.7),
                    (100.0, -9.0, 1.41),
                    (1000.0, 6.0, 4.32),
                    (5000.0, -15.0, 0.5),
                    (12_000.0, 3.0, 2.0),
                    (18_000.0, 10.0, 0.707),
                ] {
                    let c = Coeffs::design(kind, f0, g, q, fs);
                    let w0 = TAU * f0 / fs;
                    for i in 0..200 {
                        let f = 10f64.powf(1.0 + (i as f64 / 199.0) * (fs * 0.499 / 10.0).log10());
                        let omega = (PI * f / fs).tan() / (0.5 * w0).tan();
                        let expect = db(analog_mag_sq(kind, omega, g, q));
                        let (re, im) = c.response(f, fs);
                        let got = db(re * re + im * im);
                        let fast = c.magnitude_db(f, fs);
                        // Skip the bottom of notches/pass-band stopbands where dB values are meaningless.
                        if expect < -100.0 {
                            continue;
                        }
                        let err = (got - expect).abs().max((fast - expect).abs());
                        worst = worst.max(err);
                        assert!(
                            err <= 0.01,
                            "{kind:?} f0={f0} fs={fs} f={f}: got {got} fast {fast} expect {expect}"
                        );
                    }
                }
            }
        }
        println!("worst biquad error vs analytic prototype: {worst:.2e} dB");
    }

    #[test]
    fn dsp_biquad_center_gain_is_exact() {
        for &fs in &[44_100.0, 96_000.0] {
            let c = Coeffs::design(FilterKind::Peaking, 1000.0, 7.5, 2.0, fs);
            assert!((c.magnitude_db(1000.0, fs) - 7.5).abs() < 1e-9);
            let ls = Coeffs::design(FilterKind::LowShelf, 200.0, 6.0, BUTTERWORTH_Q, fs);
            assert!((ls.magnitude_db(5.0, fs) - 6.0).abs() < 0.01);
            assert!(
                (ls.magnitude_db(200.0, fs) - 3.0).abs() < 1e-9,
                "shelf midpoint is half the gain"
            );
        }
    }

    /// Measures the magnitude of a running filter from its impulse response (DFT at exact bins).
    fn measured_db(c: &Coeffs, fs: f64, f: f64, len: usize) -> f64 {
        let mut st = StereoState::default();
        let mut buf = vec![0.0; 2 * len];
        buf[0] = 1.0;
        buf[1] = 1.0;
        for chunk in buf.chunks_mut(64) {
            process_stereo(c, &mut st, chunk);
            st.sanitize();
        }
        let w = TAU * f / fs;
        let (mut re, mut im) = (0.0, 0.0);
        for (n, fr) in buf.as_chunks::<2>().0.iter().enumerate() {
            let (s, co) = (w * n as f64).sin_cos();
            re += fr[0] * co;
            im -= fr[0] * s;
            assert_eq!(fr[0], fr[1]);
        }
        db(re * re + im * im)
    }

    #[test]
    fn dsp_biquad_measured_impulse_response() {
        let fs = 48_000.0;
        let pk = Coeffs::design(FilterKind::Peaking, 1000.0, 9.0, 1.5, fs);
        let sh = Coeffs::design(FilterKind::HighShelf, 4000.0, -6.0, BUTTERWORTH_Q, fs);
        for c in [pk, sh] {
            for i in 0..60 {
                let f = 20.0 * 1000f64.powf(i as f64 / 59.0);
                let m = measured_db(&c, fs, f, 1 << 15);
                let e = c.magnitude_db(f, fs);
                assert!((m - e).abs() < 0.01, "f={f}: measured {m} expected {e}");
            }
        }
    }

    #[test]
    fn dsp_biquad_state_recovers_from_nan() {
        let c = Coeffs::design(FilterKind::Peaking, 100.0, 6.0, 1.0, 48_000.0);
        let mut st = StereoState::default();
        let mut buf = [f64::NAN, 1.0, 0.0, 0.0];
        process_stereo(&c, &mut st, &mut buf);
        st.sanitize();
        let mut buf = [0.5, 0.5];
        process_stereo(&c, &mut st, &mut buf);
        assert!(buf.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn dsp_biquad_flushes_denormals() {
        let c = Coeffs::design(FilterKind::LowPass, 30.0, 0.0, 0.7, 48_000.0);
        let mut st = StereoState::default();
        let mut buf = vec![0.0; 64];
        buf[0] = 1e-20;
        for _ in 0..2000 {
            process_stereo(&c, &mut st, &mut buf);
            st.sanitize();
            buf.fill(0.0);
        }
        assert_eq!(st, StereoState::default());
    }
}

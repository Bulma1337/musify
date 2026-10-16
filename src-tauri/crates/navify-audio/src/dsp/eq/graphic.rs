//! Constant-Q graphic EQ with band-interaction correction.
//!
//! Each band is an RBJ peaking filter at its ISO center frequency. Neighbouring bands overlap, so
//! setting every filter to its slider value would overshoot (e.g. three adjacent +6 dB sliders give
//! ≈ +9 dB in the middle). Instead we solve for the filter gains `g` such that the combined dB
//! response at every center frequency equals the slider value `s`:
//!
//! `F(g)_j = Σ_k H_k(f_j; g_k) = s_j`
//!
//! The peaking shape depends on its gain (it is not a scaled template), so the system is
//! nonlinear. We use Newton's method with the exact Jacobian (central differences of the actual
//! digital biquads at the device rate, so bilinear cramping near Nyquist is accounted for). It
//! converges to < 1e-6 dB in 3–5 iterations for ±12 dB settings.

use crate::api::{FilterKind, GraphicBands};
use crate::dsp::biquad::{Coeffs, FilterSpec, MAX_FREQ_RATIO};

/// Q of the octave (10-band) graphic EQ: one-octave bandwidth.
pub const Q_OCTAVE: f64 = 1.41;
/// Q of the third-octave (31-band) graphic EQ.
pub const Q_THIRD_OCTAVE: f64 = 4.32;
/// Solved filter gains are limited to this (only reached by extreme alternating settings).
const MAX_SOLVED_GAIN_DB: f64 = 36.0;
/// Slider values are limited to this.
pub const MAX_SLIDER_DB: f64 = 24.0;

pub fn band_q(bands: GraphicBands) -> f64 {
    match bands {
        GraphicBands::Ten => Q_OCTAVE,
        GraphicBands::ThirtyOne => Q_THIRD_OCTAVE,
    }
}

/// Filter specs implementing `gains_db` (one per center; missing values count as 0 dB). Bands
/// above `0.49·fs` cannot be realized and are left out.
pub fn solve(bands: GraphicBands, gains_db: &[f64], sample_rate: f64) -> Vec<FilterSpec> {
    let q = band_q(bands);
    let (freqs, targets): (Vec<f64>, Vec<f64>) = bands
        .center_frequencies()
        .iter()
        .enumerate()
        .filter(|&(_, &f)| f <= MAX_FREQ_RATIO * sample_rate)
        .map(|(i, &f)| {
            let s = gains_db
                .get(i)
                .copied()
                .filter(|g| g.is_finite())
                .unwrap_or(0.0);
            (f, s.clamp(-MAX_SLIDER_DB, MAX_SLIDER_DB))
        })
        .unzip();
    let gains = solve_gains(&freqs, &targets, q, sample_rate);
    freqs
        .iter()
        .zip(gains)
        .map(|(&f, g)| FilterSpec::new(FilterKind::Peaking, f, g, q))
        .collect()
}

fn peaking(f: f64, g: f64, q: f64, fs: f64) -> Coeffs {
    Coeffs::design(FilterKind::Peaking, f, g, q, fs)
}

/// Newton iteration for `Σ_k H_k(f_j; g_k) = s_j`.
fn solve_gains(freqs: &[f64], targets: &[f64], q: f64, fs: f64) -> Vec<f64> {
    let n = freqs.len();
    let mut g = targets.to_vec();
    if targets.iter().all(|&t| t == 0.0) {
        return g;
    }
    const H: f64 = 0.01;
    let mut jac = vec![0.0; n * n];
    let mut err = vec![0.0; n];
    for _ in 0..20 {
        // Response matrix at g and the Jacobian (column k = d/dg_k of band k's response).
        let mut max_err = 0.0f64;
        for (j, e) in err.iter_mut().enumerate() {
            *e = targets[j];
        }
        for k in 0..n {
            let c0 = peaking(freqs[k], g[k], q, fs);
            let cp = peaking(freqs[k], g[k] + H, q, fs);
            let cm = peaking(freqs[k], g[k] - H, q, fs);
            for (j, &fj) in freqs.iter().enumerate() {
                err[j] -= c0.magnitude_db(fj, fs);
                jac[j * n + k] = (cp.magnitude_db(fj, fs) - cm.magnitude_db(fj, fs)) / (2.0 * H);
            }
        }
        for e in &err {
            max_err = max_err.max(e.abs());
        }
        if max_err < 1e-7 {
            break;
        }
        let Some(delta) = solve_linear(&mut jac, &mut err, n) else {
            break;
        };
        for (gk, d) in g.iter_mut().zip(delta) {
            *gk = (*gk + d).clamp(-MAX_SOLVED_GAIN_DB, MAX_SOLVED_GAIN_DB);
        }
    }
    g
}

/// Solves `A x = b` (row-major `n×n`) by Gaussian elimination with partial pivoting. Destroys the
/// inputs. `None` if singular.
pub fn solve_linear(a: &mut [f64], b: &mut [f64], n: usize) -> Option<Vec<f64>> {
    for col in 0..n {
        let piv =
            (col..n).max_by(|&i, &j| a[i * n + col].abs().total_cmp(&a[j * n + col].abs()))?;
        if a[piv * n + col].abs() < 1e-12 {
            return None;
        }
        if piv != col {
            for k in 0..n {
                a.swap(piv * n + k, col * n + k);
            }
            b.swap(piv, col);
        }
        let d = a[col * n + col];
        for row in col + 1..n {
            let f = a[row * n + col] / d;
            if f != 0.0 {
                for k in col..n {
                    a[row * n + k] -= f * a[col * n + k];
                }
                b[row] -= f * b[col];
            }
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for k in row + 1..n {
            s -= a[row * n + k] * x[k];
        }
        x[row] = s / a[row * n + row];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsp_linear_solver() {
        let mut a = vec![2.0, 1.0, 1.0, 3.0];
        let mut b = vec![3.0, 5.0];
        let x = solve_linear(&mut a, &mut b, 2).unwrap();
        assert!((x[0] - 0.8).abs() < 1e-12 && (x[1] - 1.4).abs() < 1e-12);
    }

    #[test]
    fn dsp_graphic_flat_is_zero() {
        let specs = solve(GraphicBands::ThirtyOne, &[0.0; 31], 48_000.0);
        assert_eq!(specs.len(), 31);
        assert!(specs.iter().all(|s| s.gain_db == 0.0));
    }
}

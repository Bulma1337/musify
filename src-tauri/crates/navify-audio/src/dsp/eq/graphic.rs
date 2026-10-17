//! Graphic EQ: slider values → peaking filters whose summed response follows the slider curve.
//!
//! **Target.** The response the sliders describe is the slider values interpolated linearly on a
//! log-frequency axis between the band centers (what the curve between two slider knobs suggests).
//!
//! **Filters.** One magnitude-matched peaking filter ([`Design::Matched`], no bilinear warping, so
//! the top bands keep their width near Nyquist) at every band center, plus one at the geometric
//! midpoint of every pair of neighbouring centers: `2·n − 1` filters for `n` bands (19 for the
//! 10-band EQ, 61 for the 31-band one). With one filter per band, a sum of bells cannot follow the
//! kinks of a piecewise-linear target well enough: a single +12 dB slider deviates by ≈ 0.6 dB from
//! its triangle, and the band centers by as much. The intermediate filters halve the basis width
//! and bring every smooth curve within ≈ 0.5 dB (see the accuracy table in `tests/dsp_eq.rs`).
//! Each filter's Q is [`Q_SCALE`] divided by its local spacing in octaves (≈ 1.9 for the 10-band,
//! ≈ 5.7 for the 31-band layout; the ISO third-octave centers are not exactly equidistant), the two
//! outermost filters get [`EDGE_Q_FACTOR`] times that.
//!
//! **Edge bands are peaking filters, not shelves.** Outside the outermost centers the response
//! returns to 0 dB. A shelf would carry the edge slider's gain down to DC or up to Nyquist, i.e.
//! boost subsonic rumble and, at 96/192 kHz, ultrasonic noise (DSD-sourced masters carry plenty)
//! that nobody hears but the auto headroom, the limiter and the tweeters have to deal with.
//!
//! **Solve.** The gains `g` minimize the weighted squared dB error at the band centers (weight
//! [`CENTER_WEIGHT`]) and at [`POINTS_PER_INTERVAL`] log-spaced points between neighbouring
//! centers (weight 1). The bell shape depends on its gain, so this is a nonlinear least-squares
//! problem; it is solved with Levenberg–Marquardt on the exact digital responses at the device
//! rate (forward-difference Jacobian), starting from 0 dB. 4–6 iterations reach a 1e-6 dB step.
//! The TypeScript mirror (`src/features/equalizer/eqMath.ts`) implements the same algorithm; the
//! golden fixture `src/features/equalizer/eqGolden.json` keeps both in sync.

use crate::api::GraphicBands;
#[cfg(doc)]
use crate::dsp::biquad::Design;
use crate::dsp::biquad::{Coeffs, FilterSpec, MAX_FREQ_RATIO, phi};

/// Q of a graphic filter = `Q_SCALE / spacing in octaves`.
pub const Q_SCALE: f64 = 0.95;
/// Extra Q factor of the lowest and highest filter.
pub const EDGE_Q_FACTOR: f64 = 1.25;
/// Fit points strictly between two neighbouring band centers.
pub const POINTS_PER_INTERVAL: usize = 4;
/// Weight of the band centers relative to the intermediate points.
pub const CENTER_WEIGHT: f64 = 2.0;
/// Solved filter gains are limited to this (only reached by extreme alternating settings).
const MAX_SOLVED_GAIN_DB: f64 = 36.0;
/// Slider values are limited to this.
pub const MAX_SLIDER_DB: f64 = 24.0;
const MAX_ITERATIONS: usize = 30;
const MAX_DAMPING_TRIES: usize = 8;
/// Convergence: largest gain change of an accepted step.
const STEP_TOLERANCE_DB: f64 = 1e-6;
/// Forward-difference step of the Jacobian.
const JACOBIAN_STEP_DB: f64 = 1e-3;
const LAMBDA_START: f64 = 1e-3;
const LAMBDA_MIN: f64 = 1e-9;
/// Keeps the damped normal equations regular even for a column that is all zero.
const RIDGE: f64 = 1e-12;

/// A fit point: frequency, target (dB) and weight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FitPoint {
    pub freq_hz: f64,
    pub target_db: f64,
    pub weight: f64,
}

/// Band centers usable at `sample_rate` (≤ 0.49·fs) and their slider values (missing or
/// non-finite values count as 0 dB, values are clamped to ±[`MAX_SLIDER_DB`]).
pub fn usable_bands(
    bands: GraphicBands,
    gains_db: &[f64],
    sample_rate: f64,
) -> (Vec<f64>, Vec<f64>) {
    bands
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
        .unzip()
}

/// `(frequency, Q)` of every filter for the given band centers (see the module docs).
pub fn filter_layout(centers: &[f64]) -> Vec<(f64, f64)> {
    let mut freqs = Vec::with_capacity(2 * centers.len());
    for (i, &c) in centers.iter().enumerate() {
        freqs.push(c);
        if let Some(&next) = centers.get(i + 1) {
            freqs.push((c * next).sqrt());
        }
    }
    let last = freqs.len().saturating_sub(1);
    (0..freqs.len())
        .map(|k| {
            let left = (k > 0).then(|| (freqs[k] / freqs[k - 1]).log2());
            let right = (k < last).then(|| (freqs[k + 1] / freqs[k]).log2());
            let spacing = match (left, right) {
                (Some(l), Some(r)) => 0.5 * (l + r),
                (Some(d), None) | (None, Some(d)) => d,
                (None, None) => 0.5,
            };
            let edge = if last > 0 && (k == 0 || k == last) {
                EDGE_Q_FACTOR
            } else {
                1.0
            };
            (freqs[k], edge * Q_SCALE / spacing)
        })
        .collect()
}

/// Fit points: every center plus [`POINTS_PER_INTERVAL`] log-spaced points per interval, with the
/// targets interpolated linearly on log frequency.
pub fn fit_points(centers: &[f64], targets: &[f64]) -> Vec<FitPoint> {
    let mut points = Vec::with_capacity(centers.len() * (POINTS_PER_INTERVAL + 1));
    for (i, (&f, &t)) in centers.iter().zip(targets).enumerate() {
        points.push(FitPoint {
            freq_hz: f,
            target_db: t,
            weight: CENTER_WEIGHT,
        });
        if let (Some(&f1), Some(&t1)) = (centers.get(i + 1), targets.get(i + 1)) {
            for j in 1..=POINTS_PER_INTERVAL {
                let u = j as f64 / (POINTS_PER_INTERVAL + 1) as f64;
                points.push(FitPoint {
                    freq_hz: f * (f1 / f).powf(u),
                    target_db: t + u * (t1 - t),
                    weight: 1.0,
                });
            }
        }
    }
    points
}

/// Filter specs implementing `gains_db` (one value per band center). Bands above `0.49·fs` cannot
/// be realized and are left out.
pub fn solve(bands: GraphicBands, gains_db: &[f64], sample_rate: f64) -> Vec<FilterSpec> {
    let (centers, targets) = usable_bands(bands, gains_db, sample_rate);
    let layout = filter_layout(&centers);
    let gains = if targets.iter().all(|&t| t == 0.0) {
        vec![0.0; layout.len()]
    } else {
        solve_gains(&layout, &fit_points(&centers, &targets), sample_rate)
    };
    layout
        .iter()
        .zip(gains)
        .map(|(&(f, q), g)| FilterSpec::matched_peaking(f, g, q))
        .collect()
}

#[inline]
fn design(f: f64, g: f64, q: f64, fs: f64) -> Coeffs {
    Coeffs::matched_peaking(f, g, q, fs)
}

#[inline]
fn db_sq(x: f64) -> f64 {
    10.0 * x.log10()
}

/// Summed dB response of all filters at the points (`phis` = `φ` of each point).
fn responses(layout: &[(f64, f64)], gains: &[f64], phis: &[f64], fs: f64, out: &mut [f64]) {
    out.fill(0.0);
    for (&(f, q), &g) in layout.iter().zip(gains) {
        if g == 0.0 {
            continue; // exactly 0 dB everywhere
        }
        let c = design(f, g, q, fs);
        for (o, &p) in out.iter_mut().zip(phis) {
            *o += db_sq(c.magnitude_sq_phi(p));
        }
    }
}

fn cost(points: &[FitPoint], resp: &[f64]) -> f64 {
    points
        .iter()
        .zip(resp)
        .map(|(p, r)| {
            let e = p.weight * (p.target_db - r);
            e * e
        })
        .sum()
}

/// Levenberg–Marquardt for `min_g Σ_j w_j² (t_j − Σ_k H_k(f_j; g_k))²`.
fn solve_gains(layout: &[(f64, f64)], points: &[FitPoint], fs: f64) -> Vec<f64> {
    let n = layout.len();
    let m = points.len();
    let phis: Vec<f64> = points.iter().map(|p| phi(p.freq_hz, fs)).collect();
    let mut g = vec![0.0; n];
    let mut resp = vec![0.0; m];
    responses(layout, &g, &phis, fs, &mut resp);
    let mut current = cost(points, &resp);
    // Weighted Jacobian, column-major: jac[k·m + j] = w_j · ∂H(f_j)/∂g_k.
    let mut jac = vec![0.0; n * m];
    let mut wr = vec![0.0; m];
    let mut jtj = vec![0.0; n * n];
    let mut jtr = vec![0.0; n];
    let mut trial = vec![0.0; n];
    let mut trial_resp = vec![0.0; m];
    let mut lambda = LAMBDA_START;
    for _ in 0..MAX_ITERATIONS {
        for (k, &(f, q)) in layout.iter().enumerate() {
            let c0 = design(f, g[k], q, fs);
            let c1 = design(f, g[k] + JACOBIAN_STEP_DB, q, fs);
            let col = &mut jac[k * m..(k + 1) * m];
            for ((jv, &p), pt) in col.iter_mut().zip(&phis).zip(points) {
                let ratio = c1.magnitude_sq_phi(p) / c0.magnitude_sq_phi(p);
                *jv = pt.weight * db_sq(ratio) / JACOBIAN_STEP_DB;
            }
        }
        for ((w, p), r) in wr.iter_mut().zip(points).zip(&resp) {
            *w = p.weight * (p.target_db - r);
        }
        for a in 0..n {
            let ca = &jac[a * m..(a + 1) * m];
            jtr[a] = dot(ca, &wr);
            for b in a..n {
                let v = dot(ca, &jac[b * m..(b + 1) * m]);
                jtj[a * n + b] = v;
                jtj[b * n + a] = v;
            }
        }
        let mut step = None;
        for _ in 0..MAX_DAMPING_TRIES {
            let mut lhs = jtj.clone();
            for i in 0..n {
                lhs[i * n + i] += lambda * jtj[i * n + i] + RIDGE;
            }
            let mut rhs = jtr.clone();
            let Some(delta) = solve_linear(&mut lhs, &mut rhs, n) else {
                break;
            };
            for ((t, &gk), d) in trial.iter_mut().zip(&g).zip(delta) {
                *t = (gk + d).clamp(-MAX_SOLVED_GAIN_DB, MAX_SOLVED_GAIN_DB);
            }
            responses(layout, &trial, &phis, fs, &mut trial_resp);
            let c = cost(points, &trial_resp);
            if c <= current {
                let max_step = trial
                    .iter()
                    .zip(&g)
                    .map(|(t, gk)| (t - gk).abs())
                    .fold(0.0, f64::max);
                g.copy_from_slice(&trial);
                resp.copy_from_slice(&trial_resp);
                current = c;
                lambda = (lambda * 0.1).max(LAMBDA_MIN);
                step = Some(max_step);
                break;
            }
            lambda *= 10.0;
        }
        match step {
            Some(s) if s >= STEP_TOLERANCE_DB => {}
            _ => break,
        }
    }
    g
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Solves `A x = b` (row-major `n×n`) by Gaussian elimination with partial pivoting. Destroys the
/// inputs. `None` if singular.
pub fn solve_linear(a: &mut [f64], b: &mut [f64], n: usize) -> Option<Vec<f64>> {
    for col in 0..n {
        let piv =
            (col..n).max_by(|&i, &j| a[i * n + col].abs().total_cmp(&a[j * n + col].abs()))?;
        if a[piv * n + col].abs() < 1e-300 {
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
    use crate::dsp::biquad::Design;

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
        assert_eq!(specs.len(), 61);
        assert!(
            specs
                .iter()
                .all(|s| s.gain_db == 0.0 && s.design == Design::Matched)
        );
    }

    #[test]
    fn dsp_graphic_layout() {
        let ten = filter_layout(GraphicBands::Ten.center_frequencies());
        assert_eq!(ten.len(), 19);
        assert!((ten[1].0 - (31.5f64 * 63.0).sqrt()).abs() < 1e-9);
        assert!((ten[5].1 - Q_SCALE / 0.5).abs() < 1e-9, "interior Q");
        assert!(
            (ten[0].1 - EDGE_Q_FACTOR * Q_SCALE / 0.5).abs() < 1e-9,
            "edge Q"
        );
        // Bands above 0.49·fs are dropped together with their midpoint filter.
        let (centers, _) = usable_bands(GraphicBands::Ten, &[1.0; 10], 32_000.0);
        assert_eq!(centers.len(), 9);
        assert_eq!(filter_layout(&centers).len(), 17);
        let points = fit_points(&[100.0, 200.0], &[0.0, 5.0]);
        assert_eq!(points.len(), 2 + POINTS_PER_INTERVAL);
        assert!((points[1].target_db - 1.0).abs() < 1e-12);
        assert!((points[1].freq_hz - 100.0 * 2f64.powf(0.2)).abs() < 1e-9);
    }
}

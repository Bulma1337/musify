//! Stereo image: mid/side width, mono sum and constant-power balance, as one smoothed 2×2 matrix.
//!
//! With `M = (L+R)/2`, `S = (L−R)/2`: `L' = gL·(M + w·S)`, `R' = gR·(M − w·S)`.
//! - width `w` ∈ [0, 2] (0 = mono, 1 = unchanged); `mono` forces `w = 0`, i.e. `L' = R' = (L+R)/2`.
//! - balance `b` ∈ [−1, 1], constant power normalized to unity at the center:
//!   `θ = (b+1)·π/4`, `gL = √2·cos θ`, `gR = √2·sin θ` (`gL² + gR² = 2`; hard left/right is +3 dB
//!   on the remaining side).

use std::f64::consts::{FRAC_PI_4, SQRT_2};

use crate::api::StereoConfig;
use crate::dsp::smooth::{Ramp, chunk_frac};

const IDENTITY: [f64; 4] = [1.0, 0.0, 0.0, 1.0];

/// Balance gains `(gL, gR)`; exactly `(1, 1)` at the center and exactly 0 on the muted side.
pub fn balance_gains(balance: f64) -> (f64, f64) {
    let b = if balance.is_finite() {
        balance.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    if b == 0.0 {
        return (1.0, 1.0);
    }
    if b >= 1.0 {
        return (0.0, SQRT_2);
    }
    if b <= -1.0 {
        return (SQRT_2, 0.0);
    }
    let theta = (b + 1.0) * FRAC_PI_4;
    (SQRT_2 * theta.cos(), SQRT_2 * theta.sin())
}

/// Row-major `[ll, lr, rl, rr]` matrix for width `w` and balance `b`.
pub fn matrix(width: f64, balance: f64) -> [f64; 4] {
    let (gl, gr) = balance_gains(balance);
    let a = 0.5 * (1.0 + width);
    let c = 0.5 * (1.0 - width);
    [gl * a, gl * c, gr * c, gr * a]
}

pub fn effective_width(cfg: &StereoConfig) -> f64 {
    if cfg.mono {
        0.0
    } else if cfg.width.is_finite() {
        cfg.width.clamp(0.0, 2.0)
    } else {
        1.0
    }
}

pub struct StereoStage {
    width: Ramp,
    balance: Ramp,
    m0: [f64; 4],
    m1: [f64; 4],
}

impl StereoStage {
    pub fn new() -> Self {
        Self {
            width: Ramp::new(1.0),
            balance: Ramp::new(0.0),
            m0: IDENTITY,
            m1: IDENTITY,
        }
    }

    pub fn set_config(&mut self, cfg: &StereoConfig) {
        self.width.set_target(effective_width(cfg));
        let b = if cfg.balance.is_finite() {
            cfg.balance.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.balance.set_target(b);
    }

    pub fn begin_chunk(&mut self, alpha: f64) {
        self.width.advance(alpha);
        self.balance.advance(alpha);
        self.m0 = self.m1;
        self.m1 = matrix(self.width.value(), self.balance.value());
    }

    fn is_static(&self) -> bool {
        self.width.is_static() && self.balance.is_static() && self.m0 == self.m1
    }

    pub fn is_neutral(&self) -> bool {
        self.is_static() && self.m1 == IDENTITY
    }

    pub fn process(&mut self, block: &mut [f64], off: usize) {
        if self.is_static() {
            let [a, b, c, d] = self.m1;
            for fr in block.as_chunks_mut::<2>().0.iter_mut() {
                let (l, r) = (fr[0], fr[1]);
                fr[0] = a * l + b * r;
                fr[1] = c * l + d * r;
            }
        } else {
            for (i, fr) in block.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                let t = chunk_frac(off + i);
                let m: [f64; 4] =
                    std::array::from_fn(|k| self.m0[k] + (self.m1[k] - self.m0[k]) * t);
                let (l, r) = (fr[0], fr[1]);
                fr[0] = m[0] * l + m[1] * r;
                fr[1] = m[2] * l + m[3] * r;
            }
        }
    }

    pub fn reset(&mut self) {
        self.width.snap();
        self.balance.snap();
        self.m1 = matrix(self.width.value(), self.balance.value());
        self.m0 = self.m1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsp_stereo_matrix_math() {
        assert_eq!(matrix(1.0, 0.0), IDENTITY);
        assert_eq!(matrix(0.0, 0.0), [0.5, 0.5, 0.5, 0.5]);
        let (l, r) = balance_gains(0.37);
        assert!((l * l + r * r - 2.0).abs() < 1e-12, "constant power");
        assert_eq!(balance_gains(1.0), (0.0, SQRT_2));
        // Width 2: L' = M + 2S = 1.5L − 0.5R.
        assert_eq!(matrix(2.0, 0.0), [1.5, -0.5, -0.5, 1.5]);
    }
}

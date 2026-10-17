//! Volume-dependent loudness compensation.
//!
//! ISO 226:2003 equal-loudness contours flatten as the level rises: lowering the playback level by
//! `Δ` dB lowers the perceived loudness of bass more than of mid frequencies. Between the 80-phon
//! and 40-phon contours the 100 Hz curve moves ≈ 0.75·Δ, i.e. ≈ 0.25 dB of extra boost is needed per
//! dB of attenuation; around 10 kHz the difference is smaller (≈ 0.1 dB/dB). We model this with a
//! low shelf at 100 Hz and a gentle high shelf at 10 kHz (both Q = 1/√2) whose gains follow the
//! attenuation with a soft cap:
//!
//! `low = 10·tanh(0.25·att / 10)`, `high = 4·tanh(0.10·att / 4)` (att = −20·log10(volume gain))
//!
//! → 0 dB at full volume; at −20 dB: +4.6/+1.9 dB, at −40 dB: +7.6/+3.1 dB, never above +10/+4 dB.
//! The boost is always well below the attenuation, so it never raises the output level above full
//! volume. Shelf gains follow the smoothed volume and are smoothed themselves.

use crate::api::FilterKind;
use crate::dsp::biquad::{BUTTERWORTH_Q, FilterSpec, StereoState};
use crate::dsp::smooth::SmoothFilter;

pub const LOW_SHELF_HZ: f64 = 100.0;
pub const HIGH_SHELF_HZ: f64 = 10_000.0;
pub const LOW_CAP_DB: f64 = 10.0;
pub const HIGH_CAP_DB: f64 = 4.0;
const LOW_SLOPE: f64 = 0.25;
const HIGH_SLOPE: f64 = 0.10;

/// `(low_db, high_db)` shelf boosts for a linear volume gain.
pub fn boost_db(volume_gain: f64) -> (f64, f64) {
    if volume_gain >= 1.0 || volume_gain.is_nan() {
        return (0.0, 0.0);
    }
    let att = -20.0 * volume_gain.max(1e-6).log10();
    (
        LOW_CAP_DB * (LOW_SLOPE * att / LOW_CAP_DB).tanh(),
        HIGH_CAP_DB * (HIGH_SLOPE * att / HIGH_CAP_DB).tanh(),
    )
}

/// Quantize targets so tiny volume ramps don't keep the filters permanently "moving".
fn quantize(db: f64) -> f64 {
    (db * 1000.0).round() / 1000.0
}

pub struct LoudnessStage {
    enabled: bool,
    low: SmoothFilter,
    high: SmoothFilter,
    states: [StereoState; 2],
}

impl LoudnessStage {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            enabled: false,
            low: SmoothFilter::new(
                FilterSpec::new(FilterKind::LowShelf, LOW_SHELF_HZ, 0.0, BUTTERWORTH_Q),
                sample_rate,
            ),
            high: SmoothFilter::new(
                FilterSpec::new(FilterKind::HighShelf, HIGH_SHELF_HZ, 0.0, BUTTERWORTH_Q),
                sample_rate,
            ),
            states: [StereoState::default(); 2],
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    fn retarget(&mut self, volume_gain: f64) {
        let (lo, hi) = if self.enabled {
            boost_db(volume_gain)
        } else {
            (0.0, 0.0)
        };
        self.low.set_target(FilterSpec::new(
            FilterKind::LowShelf,
            LOW_SHELF_HZ,
            quantize(lo),
            BUTTERWORTH_Q,
        ));
        self.high.set_target(FilterSpec::new(
            FilterKind::HighShelf,
            HIGH_SHELF_HZ,
            quantize(hi),
            BUTTERWORTH_Q,
        ));
    }

    pub fn begin_chunk(&mut self, volume_gain: f64, alpha: f64) {
        self.retarget(volume_gain);
        for (f, s) in [&mut self.low, &mut self.high]
            .into_iter()
            .zip(&mut self.states)
        {
            f.update(alpha);
            if f.is_settled_flat() {
                s.reset(); // skipped from now on; start clean when it becomes active again
            } else {
                s.sanitize();
            }
        }
    }

    /// Both shelves settled at 0 dB: the stage is skipped.
    pub fn is_neutral(&self) -> bool {
        self.low.is_settled_flat() && self.high.is_settled_flat()
    }

    pub fn process(&mut self, block: &mut [f64], off: usize) {
        if !self.low.is_settled_flat() {
            self.low.process(&mut self.states[0], block, off);
        }
        if !self.high.is_settled_flat() {
            self.high.process(&mut self.states[1], block, off);
        }
    }

    pub fn reset(&mut self, volume_gain: f64) {
        self.retarget(volume_gain);
        self.low.snap();
        self.high.snap();
        self.states = [StereoState::default(); 2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsp_loudness_curve() {
        assert_eq!(boost_db(1.0), (0.0, 0.0));
        let mut last = (0.0, 0.0);
        for i in 1..=120 {
            let g = 10f64.powf(-(i as f64) / 20.0);
            let b = boost_db(g);
            assert!(b.0 > last.0 && b.1 > last.1);
            assert!(b.0 < LOW_CAP_DB && b.1 < HIGH_CAP_DB);
            assert!(b.0 < i as f64, "boost must stay below the attenuation");
            last = b;
        }
    }
}

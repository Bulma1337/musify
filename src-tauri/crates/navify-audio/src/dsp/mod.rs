//! Master DSP chain, processed in f64 on interleaved stereo at the device sample rate.
//!
//! Order: preamp (+ auto headroom) → EQ (graphic / parametric) → loudness compensation → bass enhancer
//! → stereo (width, mono, balance) → volume → true-peak limiter (−1 dBTP).
//!
//! Contract:
//! - `process` must not allocate, lock or panic; it runs on the engine's high-priority DSP thread.
//! - Every parameter change is smoothed (no clicks). Structural changes (mode, band count, filter
//!   kinds) crossfade between the old and new filter states over ~30 ms.
//! - With a bypass config, volume 1.0 and the limiter off, `process` leaves samples bit-identical.

use crate::api::{DspConfig, EqConfig, EqResponse};

/// Error parsing an AutoEQ `ParametricEQ.txt` profile.
#[derive(Debug, thiserror::Error)]
#[error("invalid AutoEQ profile: {0}")]
pub struct AutoEqError(pub String);

pub struct DspChain {
    sample_rate: u32,
}

impl DspChain {
    pub fn new(sample_rate: u32) -> Self {
        let _ = sample_rate;
        todo!("dsp: DspChain::new")
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Applies a new configuration. May allocate (called on config changes, not per block); the
    /// switch to the new settings is smoothed inside `process`.
    pub fn set_config(&mut self, config: &DspConfig) {
        let _ = config;
        todo!("dsp: set_config")
    }

    /// Linear master gain (see [`volume_to_gain`]); smoothed.
    pub fn set_volume(&mut self, gain: f64) {
        let _ = gain;
        todo!("dsp: set_volume")
    }

    /// Processes interleaved stereo samples in place. Real-time safe.
    pub fn process(&mut self, samples: &mut [f64]) {
        let _ = samples;
        todo!("dsp: process")
    }

    /// Clears filter and limiter state (after a seek or a manual track change).
    pub fn reset(&mut self) {
        todo!("dsp: reset")
    }

    /// Delay introduced by the chain (limiter look-ahead) in frames.
    pub fn latency_frames(&self) -> usize {
        todo!("dsp: latency_frames")
    }

    /// Highest absolute sample level before the limiter since the last call, in dBFS.
    pub fn take_peak_db(&mut self) -> f32 {
        todo!("dsp: take_peak_db")
    }
}

/// Maps the UI volume (0.0…1.0) to a linear gain on a perceptual curve (≈ −60 dB … 0 dB, 0 → silence).
pub fn volume_to_gain(volume: f64) -> f64 {
    let _ = volume;
    todo!("dsp: volume_to_gain")
}

/// Frequency response of `config` at `points` log-spaced frequencies (20 Hz … 20 kHz).
pub fn eq_response(config: &EqConfig, sample_rate: u32, points: usize) -> EqResponse {
    let _ = (config, sample_rate, points);
    todo!("dsp: eq_response")
}

/// Parses an AutoEQ `ParametricEQ.txt` (`Preamp: -6.2 dB`, `Filter 1: ON PK Fc 105 Hz Gain -2.3 dB Q 0.70`, …).
pub fn parse_autoeq(text: &str) -> Result<EqConfig, AutoEqError> {
    let _ = text;
    todo!("dsp: parse_autoeq")
}

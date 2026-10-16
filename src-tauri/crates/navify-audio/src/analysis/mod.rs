//! Real-time spectrum analyzer for the EQ view.
//!
//! Contract: fed with mono samples at the device rate on the analyzer thread (never the audio
//! thread); `frame` returns log-spaced bands (20 Hz … 20 kHz) with attack/release smoothing and
//! peak hold, quantized to 0…255 for 0 = −90 dB … 255 = 0 dB.

use crate::api::SpectrumFrame;

pub struct SpectrumAnalyzer {
    sample_rate: u32,
}

impl SpectrumAnalyzer {
    pub fn new(sample_rate: u32, bands: usize) -> Self {
        let _ = (sample_rate, bands);
        todo!("analysis: SpectrumAnalyzer::new")
    }

    /// Appends mono samples to the analysis window.
    pub fn push(&mut self, mono: &[f32]) {
        let _ = mono;
        todo!("analysis: push")
    }

    /// Computes the current frame (4096-point Hann FFT, 50 % overlap). `peak_db` is passed through.
    pub fn frame(&mut self, peak_db: f32) -> SpectrumFrame {
        let _ = peak_db;
        todo!("analysis: frame")
    }
}

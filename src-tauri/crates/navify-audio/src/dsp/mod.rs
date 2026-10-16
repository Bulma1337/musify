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
//!
//! Implementation overview (see the submodules for the math):
//! - [`biquad`]: RBJ cookbook biquads (TDF-II, f64, denormal flush, Nyquist guard).
//! - `smooth`: one-pole smoothing on a fixed 32-frame grid; coefficients are recomputed once per
//!   chunk while a parameter moves, gains are interpolated linearly within the chunk.
//! - `eq`: graphic solver with band-interaction correction, parametric filters, auto headroom,
//!   response evaluation, AutoEQ import, and the crossfading filter bank.
//! - `loudness`, `bass`, `stereo`, `limiter`: the remaining stages.
//!
//! Every stage is skipped while it is neutral and settled; with everything neutral `process` only
//! measures the peak and returns, so bypass is bit-exact by construction.

mod bass;
pub mod biquad;
mod eq;
mod limiter;
mod loudness;
mod smooth;
mod stereo;

use crate::api::{DspConfig, EqConfig, EqResponse};

use self::bass::BassStage;
use self::eq::bank::EqStage;
use self::limiter::TruePeakLimiter;
use self::loudness::LoudnessStage;
use self::smooth::{CHUNK, Fade, Ramp, SMOOTH_TAU_S, chunk_alpha, crossfade_chunks};
use self::stereo::StereoStage;

pub use self::eq::graphic::{Q_OCTAVE, Q_THIRD_OCTAVE};
pub use self::limiter::CEILING_DBTP;
pub use self::loudness::boost_db as loudness_boost_db;

/// Error parsing an AutoEQ `ParametricEQ.txt` profile.
#[derive(Debug, thiserror::Error)]
#[error("invalid AutoEQ profile: {0}")]
pub struct AutoEqError(pub String);

/// Inputs are sanitized to this range (+80 dBFS) so nothing can overflow the filter states.
const MAX_INPUT: f64 = 1e4;
/// Lowest reported peak level.
const PEAK_FLOOR_DB: f32 = -120.0;

pub struct DspChain {
    sample_rate: u32,
    fs: f64,
    alpha: f64,
    /// Position inside the current 32-frame smoothing chunk.
    chunk_pos: usize,
    limiter_on: bool,
    eq: EqStage,
    loudness: LoudnessStage,
    bass: BassStage,
    stereo: StereoStage,
    volume: Ramp,
    limiter: TruePeakLimiter,
    /// Crossfade between the dry and the limited (delayed) signal when the limiter is toggled.
    limiter_fade: Fade,
    limiter_dirty: bool,
    /// Chunks to run the (re-)enabled limiter silently before fading it in, so its delay line holds
    /// audio instead of zeros (otherwise the wet signal would start with a hard onset).
    limiter_warmup: u32,
    peak: f64,
    scratch: [f64; 2 * CHUNK],
}

impl DspChain {
    pub fn new(sample_rate: u32) -> Self {
        let fs = if sample_rate >= 8_000 {
            sample_rate as f64
        } else {
            48_000.0
        };
        let fade_chunks = crossfade_chunks(fs);
        Self {
            sample_rate,
            fs,
            alpha: chunk_alpha(fs, SMOOTH_TAU_S),
            chunk_pos: 0,
            limiter_on: false,
            eq: EqStage::new(fs, fade_chunks),
            loudness: LoudnessStage::new(fs),
            bass: BassStage::new(fs),
            stereo: StereoStage::new(),
            volume: Ramp::new(1.0),
            limiter: TruePeakLimiter::new(fs),
            limiter_fade: Fade::new(fade_chunks, false),
            limiter_dirty: false,
            limiter_warmup: 0,
            peak: 0.0,
            scratch: [0.0; 2 * CHUNK],
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Applies a new configuration. May allocate (called on config changes, not per block); the
    /// switch to the new settings is smoothed inside `process`.
    pub fn set_config(&mut self, config: &DspConfig) {
        let plan = eq::plan(config, self.fs);
        self.eq
            .set_target(&plan.eq_filters, db_to_gain(plan.preamp_db));
        self.bass.set_config(&config.bass);
        self.loudness.set_enabled(config.loudness_compensation);
        self.stereo.set_config(&config.stereo);
        if config.limiter && !self.limiter_on && !self.limiter_dirty {
            self.limiter_warmup = self.limiter.latency().div_ceil(CHUNK) as u32 + 1;
        }
        self.limiter_on = config.limiter;
        self.limiter_fade.set_on(config.limiter);
    }

    /// Linear master gain (see [`volume_to_gain`]); smoothed.
    pub fn set_volume(&mut self, gain: f64) {
        let g = if gain.is_finite() {
            gain.clamp(0.0, 16.0)
        } else {
            0.0
        };
        self.volume.set_target(g);
    }

    /// Everything neutral and settled: `process` must not touch the samples.
    fn is_bypass(&self) -> bool {
        self.eq.is_identity()
            && self.loudness.is_neutral()
            && self.bass.is_neutral()
            && self.stereo.is_neutral()
            && self.volume.is_static_at(1.0)
            && self.limiter_fade.is_static_off()
            && !self.limiter_dirty
            && self.limiter_warmup == 0
    }

    /// Processes interleaved stereo samples in place. Real-time safe.
    pub fn process(&mut self, samples: &mut [f64]) {
        let len = samples.len() & !1;
        let samples = &mut samples[..len];
        if self.is_bypass() {
            self.peak = samples.iter().fold(self.peak, |p, s| p.max(s.abs()));
            return;
        }
        let frames = len / 2;
        let mut pos = 0;
        while pos < frames {
            if self.chunk_pos == 0 {
                self.begin_chunk();
            }
            let off = self.chunk_pos;
            let n = (CHUNK - off).min(frames - pos);
            self.process_block(&mut samples[2 * pos..2 * (pos + n)], off);
            self.chunk_pos = (off + n) % CHUNK;
            pos += n;
        }
    }

    fn begin_chunk(&mut self) {
        let a = self.alpha;
        self.volume.advance(a);
        self.eq.begin_chunk(a, a);
        self.loudness.begin_chunk(self.volume.value(), a);
        self.bass.begin_chunk(a, a);
        self.stereo.begin_chunk(a);
        if self.limiter_warmup > 0 && self.limiter_on {
            self.limiter_warmup -= 1;
            self.limiter_fade.hold();
        } else {
            self.limiter_warmup = 0;
            self.limiter_fade.advance();
        }
        if self.limiter_dirty && self.limiter_fade.is_static_off() {
            self.limiter.reset();
            self.limiter_dirty = false;
        }
    }

    /// `block` holds frames `off .. off + block.len()/2` of the current chunk.
    fn process_block(&mut self, block: &mut [f64], off: usize) {
        for s in block.iter_mut() {
            let v = *s;
            *s = if v.is_finite() {
                v.clamp(-MAX_INPUT, MAX_INPUT)
            } else {
                0.0
            };
        }
        self.eq.process(block, off);
        if !self.loudness.is_neutral() {
            self.loudness.process(block, off);
        }
        if !self.bass.is_neutral() {
            self.bass.process(block, off);
        }
        if !self.stereo.is_neutral() {
            self.stereo.process(block, off);
        }
        if !self.volume.is_static_at(1.0) {
            if self.volume.is_static() {
                let g = self.volume.value();
                block.iter_mut().for_each(|s| *s *= g);
            } else {
                for (i, fr) in block.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    let g = self.volume.at(off + i);
                    fr[0] *= g;
                    fr[1] *= g;
                }
            }
        }
        self.peak = block.iter().fold(self.peak, |p, s| p.max(s.abs()));
        if self.limiter_fade.is_static_off() && self.limiter_warmup == 0 {
            return;
        }
        self.limiter_dirty = true;
        if self.limiter_fade.is_static_on() {
            self.limiter.process(block);
        } else {
            let dry = &mut self.scratch[..block.len()];
            dry.copy_from_slice(block);
            self.limiter.process(block);
            for (i, (fr, d)) in block
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip(dry.as_chunks::<2>().0.iter())
                .enumerate()
            {
                let w = self.limiter_fade.at(off + i);
                fr[0] = d[0] + w * (fr[0] - d[0]);
                fr[1] = d[1] + w * (fr[1] - d[1]);
            }
        }
    }

    /// Clears filter and limiter state (after a seek or a manual track change). Pending parameter
    /// glides and crossfades jump to their end, since there is no continuous signal to protect.
    /// Real-time safe.
    pub fn reset(&mut self) {
        self.volume.snap();
        self.eq.reset();
        self.loudness.reset(self.volume.value());
        self.bass.reset();
        self.stereo.reset();
        self.limiter_fade.snap();
        self.limiter.reset();
        self.limiter_dirty = false;
        self.limiter_warmup = 0;
        self.chunk_pos = 0;
    }

    /// Delay introduced by the chain (limiter look-ahead) in frames.
    pub fn latency_frames(&self) -> usize {
        if self.limiter_on {
            self.limiter.latency()
        } else {
            0
        }
    }

    /// Highest absolute sample level before the limiter since the last call, in dBFS.
    pub fn take_peak_db(&mut self) -> f32 {
        let p = std::mem::take(&mut self.peak);
        if p > 0.0 {
            ((20.0 * p.log10()) as f32).max(PEAK_FLOOR_DB)
        } else {
            PEAK_FLOOR_DB
        }
    }
}

fn db_to_gain(db: f64) -> f64 {
    if db == 0.0 {
        1.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// Below this UI volume the dB curve fades linearly to silence.
const VOLUME_FADE_BELOW: f64 = 0.05;
/// Range of the dB curve.
const VOLUME_RANGE_DB: f64 = 60.0;

/// Maps the UI volume (0.0…1.0) to a linear gain on a perceptual curve (≈ −60 dB … 0 dB, 0 → silence).
///
/// `dB = 60·(v − 1)` (linear in dB, i.e. perceptually even steps), multiplied by a linear fade
/// `v / 0.05` below `v = 0.05` so that `v = 0` is exact silence. Monotonic; `1.0 → 1.0` exactly.
pub fn volume_to_gain(volume: f64) -> f64 {
    if volume.is_nan() || volume <= 0.0 {
        return 0.0;
    }
    if volume >= 1.0 {
        return 1.0;
    }
    let g = 10f64.powf(VOLUME_RANGE_DB * (volume - 1.0) / 20.0);
    if volume < VOLUME_FADE_BELOW {
        g * (volume / VOLUME_FADE_BELOW)
    } else {
        g
    }
}

/// Frequency response of `config` at `points` log-spaced frequencies (20 Hz … 20 kHz).
///
/// Exactly what the chain applies for this EQ with the bass enhancer off (graphic gains solved,
/// effective preamp included). A disabled EQ is flat at 0 dB. Use [`dsp_response`] to include
/// the bass enhancer's shelf (which also affects the auto headroom).
pub fn eq_response(config: &EqConfig, sample_rate: u32, points: usize) -> EqResponse {
    let dsp = DspConfig {
        eq: config.clone(),
        ..DspConfig::default()
    };
    dsp_response(&dsp, sample_rate, points)
}

/// Like [`eq_response`], including the bass enhancer's low shelf (its harmonics are not linear and
/// are not part of the curve).
pub fn dsp_response(config: &DspConfig, sample_rate: u32, points: usize) -> EqResponse {
    dsp_response_at(config, sample_rate, &eq::log_freqs(points))
}

/// Response of the linear EQ part of `config` (EQ filters, bass shelf, effective preamp) at the
/// given frequencies.
pub fn dsp_response_at(config: &DspConfig, sample_rate: u32, frequencies: &[f64]) -> EqResponse {
    let fs = if sample_rate >= 8_000 {
        sample_rate as f64
    } else {
        48_000.0
    };
    eq::response_at(&eq::plan(config, fs), fs, frequencies)
}

/// Parses an AutoEQ `ParametricEQ.txt` (`Preamp: -6.2 dB`, `Filter 1: ON PK Fc 105 Hz Gain -2.3 dB Q 0.70`, …).
pub fn parse_autoeq(text: &str) -> Result<EqConfig, AutoEqError> {
    eq::autoeq::parse(text)
}

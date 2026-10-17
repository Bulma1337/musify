//! "Deep Bass" enhancer: a low shelf plus psychoacoustic harmonics ("missing fundamental").
//!
//! Harmonics path (mono, computed from the stage input):
//! 1. Band-pass the fundamental range: 2nd-order Butterworth high-pass at 20 Hz, then a 4th-order
//!    Butterworth low-pass at `f` (= `frequency_hz`).
//! 2. Envelope-normalized waveshaper: a peak follower `e` (instant attack, 300 ms release) gives
//!    `x = b/e ∈ [−1, 1]`; `h = e·(0.6·T2(x) + 0.4·T3(x))` with Chebyshev polynomials
//!    `T2 = 2x²−1`, `T3 = 4x³−3x`. For a sinusoidal bass note this produces exactly its 2nd and 3rd
//!    harmonic, at a level proportional to the note (linear in level, so no pumping), and nothing
//!    else. A cubic polynomial at most triples the bandwidth of its (≤ 300 Hz) input, so there is
//!    no aliasing at any supported sample rate and no oversampling is needed.
//! 3. Band-pass the result: 4th-order Butterworth high-pass at `f` (removes the shaper's DC/envelope
//!    terms and keeps the generated harmonics out of the fundamental band) and a 2nd-order low-pass
//!    at `4f`.
//! 4. Mix: `0.5 · harmonics` into both channels.
//!
//! Levels (measured, 50 Hz note, `f` = 80 Hz, `harmonics = 1`): 2nd harmonic −11 dB and 3rd
//! harmonic −14 dB relative to the note, everything above the 4th < −40 dB; the output peak rises by
//! < 4 dB (test-enforced) on top of the shelf. At the default `harmonics = 0.3` the harmonics are
//! ≈ 10 dB lower still. The shelf boost is included in the auto-headroom computation; the limiter
//! catches the rest.

use crate::api::{BassEnhancerConfig, FilterKind};
use crate::dsp::biquad::{BUTTERWORTH_Q, FilterSpec, MonoState, StereoState};
use crate::dsp::eq::{bass_frequency, bass_shelf_spec};
use crate::dsp::smooth::{CHUNK, Ramp, SmoothFilter};

/// Q values of the two sections of a 4th-order Butterworth filter.
const BW4_Q: [f64; 2] = [0.541_196_100_146_197, 1.306_562_964_876_376_7];
/// Mix gain of the harmonics at `harmonics = 1`.
pub const HARMONICS_GAIN: f64 = 0.5;
const SUBSONIC_HZ: f64 = 20.0;
const ENV_RELEASE_S: f64 = 0.3;
const W2: f64 = 0.6;
const W3: f64 = 0.4;

/// Filter specs of the harmonics path: `[pre_hp, pre_lp1, pre_lp2, post_hp1, post_hp2, post_lp]`.
fn path_specs(f: f64) -> [FilterSpec; 6] {
    [
        FilterSpec::new(FilterKind::HighPass, SUBSONIC_HZ, 0.0, BUTTERWORTH_Q),
        FilterSpec::new(FilterKind::LowPass, f, 0.0, BW4_Q[0]),
        FilterSpec::new(FilterKind::LowPass, f, 0.0, BW4_Q[1]),
        FilterSpec::new(FilterKind::HighPass, f, 0.0, BW4_Q[0]),
        FilterSpec::new(FilterKind::HighPass, f, 0.0, BW4_Q[1]),
        FilterSpec::new(FilterKind::LowPass, 4.0 * f, 0.0, BUTTERWORTH_Q),
    ]
}

pub struct BassStage {
    shelf: SmoothFilter,
    shelf_state: StereoState,
    path: [SmoothFilter; 6],
    path_state: [MonoState; 6],
    env: f64,
    env_release: f64,
    mix: Ramp,
    harm: [f64; CHUNK],
}

impl BassStage {
    pub fn new(sample_rate: f64) -> Self {
        let cfg = BassEnhancerConfig::default();
        let f = bass_frequency(&cfg);
        Self {
            shelf: SmoothFilter::new(
                bass_shelf_spec(&BassEnhancerConfig {
                    enabled: false,
                    ..cfg
                }),
                sample_rate,
            ),
            shelf_state: StereoState::default(),
            path: path_specs(f).map(|s| SmoothFilter::new(s, sample_rate)),
            path_state: [MonoState::default(); 6],
            env: 0.0,
            env_release: (-1.0 / (ENV_RELEASE_S * sample_rate)).exp(),
            mix: Ramp::new(0.0),
            harm: [0.0; CHUNK],
        }
    }

    pub fn set_config(&mut self, cfg: &BassEnhancerConfig) {
        self.shelf.set_target(bass_shelf_spec(cfg));
        for (filter, spec) in self.path.iter_mut().zip(path_specs(bass_frequency(cfg))) {
            filter.set_target(spec);
        }
        let amount = if cfg.enabled && cfg.harmonics.is_finite() {
            cfg.harmonics.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.mix.set_target(HARMONICS_GAIN * amount);
    }

    fn harmonics_active(&self) -> bool {
        !self.mix.is_static_at(0.0)
    }

    pub fn is_neutral(&self) -> bool {
        self.shelf.is_settled_flat() && !self.harmonics_active()
    }

    pub fn begin_chunk(&mut self, alpha_param: f64, alpha_gain: f64) {
        self.mix.advance(alpha_gain);
        self.shelf.update(alpha_param);
        if self.shelf.is_settled_flat() {
            self.shelf_state.reset();
        } else {
            self.shelf_state.sanitize();
        }
        for f in &mut self.path {
            f.update(alpha_param);
        }
        if self.harmonics_active() {
            self.path_state.iter_mut().for_each(MonoState::sanitize);
            if self.env < 1e-30 || !self.env.is_finite() {
                self.env = 0.0;
            }
        } else {
            self.path_state.iter_mut().for_each(MonoState::reset);
            self.env = 0.0;
        }
    }

    pub fn process(&mut self, block: &mut [f64], off: usize) {
        let harmonics = self.harmonics_active();
        if harmonics {
            let [s0, s1, s2, s3, s4, s5] = &mut self.path_state;
            let mut env = self.env;
            let rel = self.env_release;
            let moving = self.path.iter().any(|f| !f.is_static());
            let [mut c0, mut c1, mut c2, mut c3, mut c4, mut c5] =
                self.path.each_ref().map(|f| *f.coeffs());
            for (i, (h, fr)) in self
                .harm
                .iter_mut()
                .zip(block.as_chunks::<2>().0.iter())
                .enumerate()
            {
                if moving {
                    [c0, c1, c2, c3, c4, c5] = self.path.each_ref().map(|f| f.coeffs_at(off + i));
                }
                let m = 0.5 * (fr[0] + fr[1]);
                let b = s2.tick(&c2, s1.tick(&c1, s0.tick(&c0, m)));
                let a = b.abs();
                env = if a > env * rel { a } else { env * rel };
                let x = if env > 1e-12 {
                    (b / env).clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                let x2 = x * x;
                let shaped = env * (W2 * (2.0 * x2 - 1.0) + W3 * x * (4.0 * x2 - 3.0));
                *h = s5.tick(&c5, s4.tick(&c4, s3.tick(&c3, shaped)));
            }
            self.env = env;
        }
        if !self.shelf.is_settled_flat() {
            self.shelf.process(&mut self.shelf_state, block, off);
        }
        if harmonics {
            for (i, (fr, h)) in block
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip(&self.harm)
                .enumerate()
            {
                let v = self.mix.at(off + i) * h;
                fr[0] += v;
                fr[1] += v;
            }
        }
    }

    pub fn reset(&mut self) {
        self.shelf.snap();
        self.shelf_state.reset();
        self.path.iter_mut().for_each(SmoothFilter::snap);
        self.path_state.iter_mut().for_each(MonoState::reset);
        self.env = 0.0;
        self.mix.snap();
    }
}

//! The running EQ stage: preamp + filter bank, with smoothing for parameter changes and an
//! old→new crossfade for structural changes (different filter count or kinds).

use crate::dsp::biquad::{FilterSpec, StereoState};
use crate::dsp::smooth::{CHUNK, Fade, Ramp, SmoothFilter};

#[derive(Clone, Debug)]
struct EqFilter {
    filter: SmoothFilter,
    state: StereoState,
}

/// Preamp followed by a cascade of smoothed biquads.
#[derive(Clone, Debug)]
pub struct Bank {
    filters: Vec<EqFilter>,
    preamp: Ramp,
}

impl Bank {
    /// A bank already settled at its targets, with cleared state.
    pub fn new(specs: &[FilterSpec], preamp_gain: f64, sample_rate: f64) -> Self {
        Self {
            filters: specs
                .iter()
                .map(|s| EqFilter {
                    filter: SmoothFilter::new(*s, sample_rate),
                    state: StereoState::default(),
                })
                .collect(),
            preamp: Ramp::new(preamp_gain),
        }
    }

    pub fn same_structure(&self, specs: &[FilterSpec]) -> bool {
        self.filters.len() == specs.len()
            && self
                .filters
                .iter()
                .zip(specs)
                .all(|(f, s)| f.filter.spec().kind == s.kind)
    }

    pub fn set_targets(&mut self, specs: &[FilterSpec], preamp_gain: f64) {
        debug_assert!(self.same_structure(specs));
        for (f, s) in self.filters.iter_mut().zip(specs) {
            f.filter.set_target(*s);
        }
        self.preamp.set_target(preamp_gain);
    }

    fn begin_chunk(&mut self, alpha_param: f64, alpha_gain: f64) {
        self.preamp.advance(alpha_gain);
        for f in &mut self.filters {
            f.filter.update(alpha_param);
            f.state.sanitize();
        }
    }

    /// Settled, unity preamp, no filters.
    pub fn is_identity(&self) -> bool {
        self.filters.is_empty() && self.preamp.is_static_at(1.0)
    }

    fn process(&mut self, block: &mut [f64], off: usize) {
        if !self.preamp.is_static_at(1.0) {
            if self.preamp.is_static() {
                let g = self.preamp.value();
                block.iter_mut().for_each(|s| *s *= g);
            } else {
                for (i, fr) in block.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    let g = self.preamp.at(off + i);
                    fr[0] *= g;
                    fr[1] *= g;
                }
            }
        }
        for f in &mut self.filters {
            f.filter.process(&mut f.state, block, off);
        }
    }

    fn reset(&mut self) {
        self.preamp.snap();
        for f in &mut self.filters {
            f.filter.snap();
            f.state.reset();
        }
    }
}

/// Banks that finished fading out are parked here and only dropped in `set_target` (never on the
/// audio thread). At most two banks retire between two `set_target` calls.
const RETIRED_CAPACITY: usize = 4;

pub struct EqStage {
    fs: f64,
    active: Bank,
    /// Bank fading out while `active` fades in.
    old: Option<Bank>,
    /// Structural change that arrived during a fade; starts when the current fade ends.
    pending: Option<Bank>,
    retired: Vec<Bank>,
    fade: Fade,
    scratch: [f64; 2 * CHUNK],
}

impl EqStage {
    pub fn new(sample_rate: f64, fade_chunks: u32) -> Self {
        Self {
            fs: sample_rate,
            active: Bank::new(&[], 1.0, sample_rate),
            old: None,
            pending: None,
            retired: Vec::with_capacity(RETIRED_CAPACITY),
            fade: Fade::new(fade_chunks, true),
            scratch: [0.0; 2 * CHUNK],
        }
    }

    /// New targets (non-real-time: may allocate and drop).
    pub fn set_target(&mut self, specs: &[FilterSpec], preamp_gain: f64) {
        self.retired.clear();
        self.retired.reserve(RETIRED_CAPACITY);
        let fading = self.old.is_some();
        let latest = match self.pending.as_mut() {
            Some(p) => p,
            None => &mut self.active,
        };
        if latest.same_structure(specs) {
            latest.set_targets(specs, preamp_gain);
            return;
        }
        let bank = Bank::new(specs, preamp_gain, self.fs);
        if fading {
            self.pending = Some(bank);
        } else {
            self.old = Some(std::mem::replace(&mut self.active, bank));
            self.fade.restart();
        }
    }

    fn retire(&mut self, bank: Bank) {
        if self.retired.len() < self.retired.capacity() {
            self.retired.push(bank);
        } else {
            // Unreachable by construction (see RETIRED_CAPACITY); never deallocate here.
            std::mem::forget(bank);
        }
    }

    pub fn begin_chunk(&mut self, alpha_param: f64, alpha_gain: f64) {
        if self.old.is_some() {
            self.fade.advance();
            if self.fade.is_static_on() {
                if let Some(done) = self.old.take() {
                    self.retire(done);
                }
                if let Some(next) = self.pending.take() {
                    self.old = Some(std::mem::replace(&mut self.active, next));
                    self.fade.restart();
                    self.fade.advance();
                }
            }
        }
        self.active.begin_chunk(alpha_param, alpha_gain);
        if let Some(old) = self.old.as_mut() {
            old.begin_chunk(alpha_param, alpha_gain);
        }
    }

    /// No work to do (and none pending).
    pub fn is_identity(&self) -> bool {
        self.old.is_none() && self.pending.is_none() && self.active.is_identity()
    }

    pub fn process(&mut self, block: &mut [f64], off: usize) {
        match self.old.as_mut() {
            None => {
                if !self.active.is_identity() {
                    self.active.process(block, off);
                }
            }
            Some(old) => {
                let scratch = &mut self.scratch[..block.len()];
                scratch.copy_from_slice(block);
                old.process(scratch, off);
                self.active.process(block, off);
                for (i, (fr, o)) in block
                    .as_chunks_mut::<2>()
                    .0
                    .iter_mut()
                    .zip(scratch.as_chunks::<2>().0.iter())
                    .enumerate()
                {
                    let w = self.fade.at(off + i);
                    fr[0] = o[0] + w * (fr[0] - o[0]);
                    fr[1] = o[1] + w * (fr[1] - o[1]);
                }
            }
        }
    }

    /// Clears state, finishes fades and snaps all smoothing (real-time safe).
    pub fn reset(&mut self) {
        if let Some(done) = self.old.take() {
            self.retire(done);
        }
        if let Some(next) = self.pending.take() {
            let done = std::mem::replace(&mut self.active, next);
            self.retire(done);
        }
        self.fade.snap();
        self.active.reset();
    }
}

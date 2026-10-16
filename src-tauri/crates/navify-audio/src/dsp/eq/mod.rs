//! EQ planning: turns a [`DspConfig`] into the exact filter list the chain runs, computes the
//! auto-headroom preamp, and evaluates the resulting frequency response.

pub mod autoeq;
pub mod bank;
pub mod graphic;

use crate::api::{BassEnhancerConfig, DspConfig, EqConfig, EqMode, EqResponse, FilterKind};
use crate::dsp::biquad::{BUTTERWORTH_Q, Coeffs, FilterSpec};

/// Number of log-spaced points (20 Hz…20 kHz) the auto headroom is evaluated on.
pub const HEADROOM_POINTS: usize = 512;
pub const F_MIN: f64 = 20.0;
pub const F_MAX: f64 = 20_000.0;
/// Manual preamp range.
pub const MAX_PREAMP_DB: f64 = 30.0;
/// Bass enhancer shelf limits.
pub const BASS_FREQ_RANGE: (f64, f64) = (20.0, 300.0);
pub const BASS_MAX_BOOST_DB: f64 = 24.0;

/// Everything the chain applies linearly before the nonlinear/volume stages.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// EQ filters in processing order (empty when the EQ is disabled).
    pub eq_filters: Vec<FilterSpec>,
    /// Bass-enhancer low shelf (when the enhancer is enabled).
    pub bass_shelf: Option<FilterSpec>,
    /// Highest boost of all filters (dB) between 20 Hz and 20 kHz.
    pub max_boost_db: f64,
    /// Preamp actually applied (manual preamp minus auto headroom).
    pub preamp_db: f64,
}

pub fn bass_frequency(b: &BassEnhancerConfig) -> f64 {
    let f = if b.frequency_hz.is_finite() {
        b.frequency_hz
    } else {
        80.0
    };
    f.clamp(BASS_FREQ_RANGE.0, BASS_FREQ_RANGE.1)
}

/// The enhancer's low shelf (gain 0 when disabled).
pub fn bass_shelf_spec(b: &BassEnhancerConfig) -> FilterSpec {
    let boost = if b.enabled && b.boost_db.is_finite() {
        b.boost_db.clamp(0.0, BASS_MAX_BOOST_DB)
    } else {
        0.0
    };
    FilterSpec::new(
        FilterKind::LowShelf,
        bass_frequency(b),
        boost,
        BUTTERWORTH_Q,
    )
}

/// EQ filters exactly as the chain runs them (graphic gains already solved).
pub fn eq_filters(eq: &EqConfig, sample_rate: f64) -> Vec<FilterSpec> {
    if !eq.enabled {
        return Vec::new();
    }
    match &eq.mode {
        EqMode::Graphic { bands, gains_db } => graphic::solve(*bands, gains_db, sample_rate),
        EqMode::Parametric { filters } => filters
            .iter()
            .filter(|f| f.enabled)
            .map(|f| FilterSpec::new(f.kind, f.freq_hz, f.gain_db, f.q).clamped(sample_rate))
            .collect(),
    }
}

pub fn plan(config: &DspConfig, sample_rate: f64) -> Plan {
    let eq_filters = eq_filters(&config.eq, sample_rate);
    let bass_shelf = config
        .bass
        .enabled
        .then(|| bass_shelf_spec(&config.bass).clamped(sample_rate));
    let coeffs: Vec<Coeffs> = eq_filters
        .iter()
        .chain(bass_shelf.iter())
        .map(|s| s.coeffs(sample_rate))
        .collect();
    let max_boost_db = if coeffs.is_empty() {
        0.0
    } else {
        max_boost(&coeffs, &eq_filters, sample_rate)
    };
    let manual = if config.eq.enabled && config.eq.preamp_db.is_finite() {
        config.eq.preamp_db.clamp(-MAX_PREAMP_DB, MAX_PREAMP_DB)
    } else {
        0.0
    };
    // Auto headroom follows `eq.auto_headroom` even when only the bass enhancer is on, so the
    // enhancer's shelf never pushes the signal into the limiter/clipping by itself.
    let headroom = if config.eq.auto_headroom {
        max_boost_db.max(0.0)
    } else {
        0.0
    };
    Plan {
        eq_filters,
        bass_shelf,
        max_boost_db,
        preamp_db: manual - headroom,
    }
}

fn total_db(coeffs: &[Coeffs], f: f64, fs: f64) -> f64 {
    coeffs.iter().map(|c| c.magnitude_db(f, fs)).sum()
}

pub fn log_freqs(points: usize) -> Vec<f64> {
    match points {
        0 => Vec::new(),
        1 => vec![F_MIN],
        _ => {
            let r = (F_MAX / F_MIN).ln();
            (0..points)
                .map(|i| F_MIN * (r * i as f64 / (points - 1) as f64).exp())
                .collect()
        }
    }
}

/// Maximum of the combined response on the 512-point grid, at every filter frequency, and refined
/// around the grid maximum with a golden-section search (a narrow peak between grid points is not
/// missed).
fn max_boost(coeffs: &[Coeffs], specs: &[FilterSpec], fs: f64) -> f64 {
    let grid = log_freqs(HEADROOM_POINTS);
    let in_band = |f: f64| (F_MIN..=F_MAX).contains(&f) && f < 0.5 * fs;
    let mut best = f64::NEG_INFINITY;
    let mut best_i = 0;
    for (i, &f) in grid.iter().enumerate().filter(|&(_, &f)| f < 0.5 * fs) {
        let v = total_db(coeffs, f, fs);
        if v > best {
            best = v;
            best_i = i;
        }
    }
    for s in specs.iter().filter(|s| in_band(s.freq_hz)) {
        best = best.max(total_db(coeffs, s.freq_hz, fs));
    }
    // Golden-section refinement on ln f between the grid neighbours of the maximum.
    let lo = grid[best_i.saturating_sub(1)].ln();
    let hi = grid[(best_i + 1).min(grid.len() - 1)]
        .ln()
        .min((0.499 * fs).ln());
    if hi > lo {
        let eval = |x: f64| total_db(coeffs, x.exp(), fs);
        let gr = 0.618_033_988_749_894_9;
        let (mut a, mut b) = (lo, hi);
        let mut c = b - gr * (b - a);
        let mut d = a + gr * (b - a);
        let (mut fc, mut fd) = (eval(c), eval(d));
        for _ in 0..48 {
            if fc > fd {
                b = d;
                d = c;
                fd = fc;
                c = b - gr * (b - a);
                fc = eval(c);
            } else {
                a = c;
                c = d;
                fc = fd;
                d = a + gr * (b - a);
                fd = eval(d);
            }
        }
        best = best.max(fc).max(fd);
    }
    best
}

/// Response of `plan` (all filters + effective preamp) at `freqs`.
pub fn response_at(plan: &Plan, sample_rate: f64, freqs: &[f64]) -> EqResponse {
    let coeffs: Vec<Coeffs> = plan
        .eq_filters
        .iter()
        .chain(plan.bass_shelf.iter())
        .map(|s| s.coeffs(sample_rate))
        .collect();
    EqResponse {
        frequencies: freqs.to_vec(),
        magnitude_db: freqs
            .iter()
            .map(|&f| plan.preamp_db + total_db(&coeffs, f, sample_rate))
            .collect(),
        max_boost_db: plan.max_boost_db,
        effective_preamp_db: plan.preamp_db,
    }
}

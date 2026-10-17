//! Click test: every kind of parameter change during playback of a steady sine must be free of
//! discontinuities.
//!
//! Method: play a two-channel sine at `f0` (−12/−14 dBFS), apply a parameter change every 150 ms,
//! and high-pass the output with a 12th-order Butterworth at `2·f0` (72 dB/octave: the steady tone
//! leaks at ≈ −88 dBFS, the measured floor). Smooth glides only create sidebands within a few tens
//! of Hz of the tone, which stay in the stopband; a discontinuity in value or slope is broadband and
//! shows up in the residual.
//!
//! Threshold −66 dBFS: `dsp_click_detector_sees_a_hard_step` shows that an instantaneous 1 % gain
//! step on the same tone (a barely audible click) reads ≈ −60 dBFS, so the threshold flags anything
//! at least that bad with 6 dB margin. Measured worst case: ≈ −82 dBFS for a 1 kHz tone (all rates)
//! and ≈ −70 dBFS for 250 Hz (structural EQ crossfade), i.e. well below the threshold.

mod dsp_common;

use std::f64::consts::PI;

use dsp_common::*;
use navify_audio::api::{
    BassEnhancerConfig, DspConfig, EqConfig, EqMode, FilterKind, GraphicBands, StereoConfig,
};
use navify_audio::dsp::DspChain;

const THRESHOLD_DBFS: f64 = -66.0;

enum Change {
    Config(Box<dyn Fn(&mut DspConfig)>),
    Volume(f64),
}

fn cfg(f: impl Fn(&mut DspConfig) + 'static) -> Change {
    Change::Config(Box::new(f))
}

fn changes(with_bass: bool) -> Vec<(&'static str, Change)> {
    let mut v: Vec<(&'static str, Change)> = vec![
        (
            "graphic sliders",
            cfg(|c| {
                if let EqMode::Graphic { gains_db, .. } = &mut c.eq.mode {
                    for (i, g) in gains_db.iter_mut().enumerate() {
                        *g = if i % 2 == 0 { 9.0 } else { -7.0 };
                    }
                }
            }),
        ),
        ("preamp", cfg(|c| c.eq.preamp_db = -6.0)),
        ("auto headroom off", cfg(|c| c.eq.auto_headroom = false)),
        (
            "10 → 31 bands",
            cfg(|c| {
                c.eq.mode = EqMode::Graphic {
                    bands: GraphicBands::ThirtyOne,
                    gains_db: (0..31).map(|i| ((i * 5) % 11) as f64 - 5.0).collect(),
                }
            }),
        ),
        (
            "graphic → parametric",
            cfg(|c| {
                c.eq.mode = EqMode::Parametric {
                    filters: vec![
                        pf(FilterKind::Peaking, 300.0, 6.0, 1.0),
                        pf(FilterKind::HighShelf, 4000.0, -4.0, 0.7),
                    ],
                }
            }),
        ),
        (
            "parametric freq through the tone",
            cfg(|c| set_pk(c, |f| f.freq_hz = 3000.0)),
        ),
        ("parametric gain", cfg(|c| set_pk(c, |f| f.gain_db = -9.0))),
        ("parametric Q", cfg(|c| set_pk(c, |f| f.q = 6.0))),
        (
            "add filter",
            cfg(|c| push(c, pf(FilterKind::LowPass, 8000.0, 0.0, 0.7))),
        ),
        (
            "filter kind change",
            cfg(|c| set_pk(c, |f| f.kind = FilterKind::Notch)),
        ),
        ("EQ off", cfg(|c| c.eq.enabled = false)),
        ("EQ on", cfg(|c| c.eq.enabled = true)),
        ("loudness on", cfg(|c| c.loudness_compensation = true)),
        ("volume down", Change::Volume(0.2)),
        ("volume up", Change::Volume(0.8)),
        ("loudness off", cfg(|c| c.loudness_compensation = false)),
        ("width 2", cfg(|c| c.stereo.width = 2.0)),
        ("width 0.3", cfg(|c| c.stereo.width = 0.3)),
        ("mono on", cfg(|c| c.stereo.mono = true)),
        ("mono off", cfg(|c| c.stereo.mono = false)),
        ("balance", cfg(|c| c.stereo.balance = 0.7)),
        ("balance back", cfg(|c| c.stereo.balance = -0.4)),
        ("limiter off", cfg(|c| c.limiter = false)),
        ("limiter on", cfg(|c| c.limiter = true)),
        ("volume to 1", Change::Volume(1.0)),
    ];
    if with_bass {
        v.extend([
            (
                "bass on",
                cfg(|c| {
                    c.bass = BassEnhancerConfig {
                        enabled: true,
                        boost_db: 6.0,
                        frequency_hz: 80.0,
                        harmonics: 0.3,
                    }
                }),
            ),
            ("bass boost", cfg(|c| c.bass.boost_db = 12.0)),
            ("bass frequency", cfg(|c| c.bass.frequency_hz = 140.0)),
            ("bass harmonics", cfg(|c| c.bass.harmonics = 1.0)),
            ("bass off", cfg(|c| c.bass.enabled = false)),
        ]);
    }
    v
}

fn set_pk(c: &mut DspConfig, f: impl Fn(&mut navify_audio::api::ParametricFilter)) {
    if let EqMode::Parametric { filters } = &mut c.eq.mode {
        f(&mut filters[0]);
    }
}

fn push(c: &mut DspConfig, p: navify_audio::api::ParametricFilter) {
    if let EqMode::Parametric { filters } = &mut c.eq.mode {
        filters.push(p);
    }
}

/// Max residual (dBFS) during the change sequence and in a steady reference run.
fn run(fs: u32, f0: f64, with_bass: bool) -> (f64, f64, &'static str) {
    let mut config = DspConfig {
        eq: EqConfig {
            enabled: true,
            preamp_db: 0.0,
            auto_headroom: true,
            mode: EqMode::Graphic {
                bands: GraphicBands::Ten,
                gains_db: vec![2.0, -1.0, 3.0, 0.0, -2.0, 1.0, 4.0, -3.0, 2.0, 0.0],
            },
        },
        bass: BassEnhancerConfig::default(),
        stereo: StereoConfig::default(),
        loudness_compensation: false,
        limiter: true,
    };
    let seq = changes(with_bass);
    let step = (0.15 * fs as f64) as usize;
    let warm = fs as usize / 2;
    let total = warm + step * (seq.len() + 2);
    let mut chain = DspChain::new(fs);
    chain.set_config(&config);
    chain.set_volume(1.0);
    chain.reset();
    let mut steady = DspChain::new(fs);
    steady.set_config(&config);
    steady.reset();

    let tone = |n: usize| {
        let t = n as f64 / fs as f64;
        (
            0.25 * (2.0 * PI * f0 * t).sin(),
            0.2 * (2.0 * PI * f0 * t + 0.7).sin(),
        )
    };
    let mut out = Vec::with_capacity(2 * total);
    let mut ref_out = Vec::with_capacity(2 * total);
    let block = 256;
    let mut next_change = warm;
    let mut idx = 0;
    let mut n = 0;
    let mut change_at = Vec::new();
    while n < total {
        if n >= next_change && idx < seq.len() {
            match &seq[idx].1 {
                Change::Config(f) => {
                    f(&mut config);
                    chain.set_config(&config);
                }
                Change::Volume(v) => chain.set_volume(*v),
            }
            change_at.push((n, seq[idx].0));
            idx += 1;
            next_change += step;
        }
        let len = block.min(total - n);
        let mut buf: Vec<f64> = (n..n + len)
            .flat_map(|i| {
                let (l, r) = tone(i);
                [l, r]
            })
            .collect();
        let mut buf2 = buf.clone();
        chain.process(&mut buf);
        steady.process(&mut buf2);
        out.extend_from_slice(&buf);
        ref_out.extend_from_slice(&buf2);
        n += len;
    }
    let hp = highpass12(&out, 2.0 * f0, fs as f64);
    let hp_ref = highpass12(&ref_out, 2.0 * f0, fs as f64);
    let max_from =
        |x: &[f64], a: usize, b: usize| x[2 * a..2 * b].iter().fold(0.0f64, |p, v| p.max(v.abs()));
    let floor = db(max_from(&hp_ref, warm, total));
    // Attribute the worst residual to a change.
    let mut worst = f64::NEG_INFINITY;
    let mut worst_name = "";
    for (k, &(at, name)) in change_at.iter().enumerate() {
        let end = change_at.get(k + 1).map_or(total, |c| c.0);
        let r = db(max_from(&hp, at, end));
        if r > worst {
            worst = r;
            worst_name = name;
        }
    }
    (worst, floor, worst_name)
}

#[test]
fn dsp_parameter_changes_are_click_free() {
    for (fs, f0, bass) in [
        (48_000u32, 1000.0, true),
        (44_100, 1000.0, true),
        (96_000, 1000.0, true),
        (48_000, 250.0, false),
    ] {
        let (worst, floor, name) = run(fs, f0, bass);
        println!(
            "fs={fs} f0={f0}: worst residual {worst:.1} dBFS (at \"{name}\"), steady floor {floor:.1} dBFS"
        );
        assert!(
            worst < THRESHOLD_DBFS,
            "fs={fs} f0={f0}: click of {worst:.1} dBFS at \"{name}\""
        );
    }
}

/// Sanity check of the method: a hard 1 % gain step is detected.
#[test]
fn dsp_click_detector_sees_a_hard_step() {
    let fs = 48_000.0;
    let f0 = 1000.0;
    let x: Vec<f64> = (0..48_000)
        .flat_map(|n| {
            let g = if n < 24_012 { 1.0 } else { 0.99 };
            let v = g * 0.25 * (2.0 * PI * f0 * n as f64 / fs).sin();
            [v, v]
        })
        .collect();
    let hp = highpass12(&x, 2.0 * f0, fs);
    let r = db(hp[2 * 20_000..].iter().fold(0.0f64, |p, v| p.max(v.abs())));
    println!("1 % step residual: {r:.1} dBFS");
    assert!(r > THRESHOLD_DBFS);
}

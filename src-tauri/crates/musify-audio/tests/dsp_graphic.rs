//! Graphic EQ accuracy against the slider curve, end-to-end measurement through the running chain,
//! solve timing and the golden fixture shared with the TypeScript mirror.
//!
//! Accuracy table: `cargo test -p musify-audio --release --test dsp_graphic -- --nocapture`
//! Regenerate the golden fixture after an intentional change of the design:
//! `cargo test -p musify-audio --test dsp_graphic -- --ignored write_graphic_golden`

mod dsp_common;

use std::f64::consts::TAU;
use std::time::Instant;

use dsp_common::*;
use musify_audio::api::{BassEnhancerConfig, DspConfig, GraphicBands};
use musify_audio::dsp::{DspChain, dsp_response, dsp_response_at, graphic_filters};
use serde::{Deserialize, Serialize};

const RATES: [u32; 4] = [44_100, 48_000, 96_000, 192_000];

/// The built-in presets of `src/features/equalizer/presets.ts` (10-band values). The golden fixture
/// carries them, and the Vitest side checks that they still equal the shipped presets.
const PRESETS: [(&str, [f64; 10]); 22] = [
    ("flat", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    (
        "deepBass",
        [3.0, 3.0, 2.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "bassBooster",
        [6.0, 5.5, 4.0, 2.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "bassReducer",
        [-6.0, -5.0, -3.5, -1.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
    (
        "vShape",
        [5.0, 4.0, 2.0, -1.0, -3.0, -3.0, -1.0, 2.0, 4.5, 5.0],
    ),
    (
        "headphoneTarget",
        [5.0, 4.5, 2.0, 0.0, -0.5, 0.0, 1.0, 2.5, -1.0, -2.0],
    ),
    (
        "vocal",
        [-3.0, -2.5, -1.5, 0.0, 1.5, 3.0, 3.5, 2.5, 0.5, 0.0],
    ),
    (
        "acoustic",
        [4.0, 3.5, 2.5, 0.5, 1.0, 1.0, 2.0, 2.5, 3.0, 2.0],
    ),
    (
        "classical",
        [2.0, 1.5, 1.0, 0.5, 0.0, 0.0, 0.0, 1.0, 2.0, 2.5],
    ),
    (
        "electronic",
        [5.0, 4.5, 1.5, 0.0, -2.0, 2.0, 0.5, 1.5, 4.5, 5.0],
    ),
    (
        "hipHop",
        [5.5, 5.0, 2.5, 3.0, -1.0, -1.0, 1.5, -0.5, 2.0, 3.0],
    ),
    ("rock", [5.0, 4.0, 2.5, 1.0, -1.0, -1.5, 0.5, 2.5, 3.5, 4.0]),
    (
        "metal",
        [4.5, 3.5, 0.0, 1.5, -1.5, -2.5, 0.0, 2.0, 4.0, 4.5],
    ),
    (
        "pop",
        [-1.5, -0.5, 1.5, 3.0, 3.5, 3.0, 1.5, 0.0, -0.5, -1.5],
    ),
    ("jazz", [2.5, 2.0, 1.0, 2.0, -1.0, -1.0, 0.0, 1.5, 2.5, 3.0]),
    (
        "dance",
        [6.0, 5.0, 3.0, 0.5, 0.0, -1.5, -1.0, 0.0, 3.0, 3.5],
    ),
    (
        "loudness",
        [6.0, 4.5, 1.5, 0.0, -1.0, -1.0, 0.0, 1.0, 3.5, 5.0],
    ),
    (
        "trebleBooster",
        [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.5, 4.0, 5.5, 6.0],
    ),
    (
        "trebleReducer",
        [0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -2.5, -4.0, -5.5, -6.0],
    ),
    (
        "lateNight",
        [-4.0, -3.0, -1.5, 0.0, 1.0, 1.5, 1.0, -0.5, -2.0, -3.5],
    ),
    (
        "smallSpeakers",
        [-8.0, -6.0, -2.0, 2.5, 2.0, 1.0, 1.5, 2.5, 2.0, 0.5],
    ),
    (
        "speech",
        [-8.0, -6.0, -3.0, -0.5, 1.5, 3.0, 3.5, 2.0, -1.0, -3.0],
    ),
];

/// Same as `resampleGraphicGains` in `eqMath.ts` (log-frequency interpolation, edge hold, 0.1 dB).
fn resample(gains: &[f64], from: GraphicBands, to: GraphicBands) -> Vec<f64> {
    let src: Vec<f64> = from.center_frequencies().iter().map(|f| f.log2()).collect();
    to.center_frequencies()
        .iter()
        .map(|f| {
            let x = f.log2();
            let v = if x <= src[0] {
                gains[0]
            } else if x >= src[src.len() - 1] {
                gains[gains.len() - 1]
            } else {
                let mut i = 0;
                while i < src.len() - 2 && src[i + 1] < x {
                    i += 1;
                }
                let t = (x - src[i]) / (src[i + 1] - src[i]);
                gains[i] + t * (gains[i + 1] - gains[i])
            };
            (v * 10.0).round() / 10.0
        })
        .collect()
}

/// Slider values interpolated linearly on log frequency (the target curve).
fn target(centers: &[f64], gains: &[f64], f: f64) -> f64 {
    let x = f.ln();
    let i = centers
        .windows(2)
        .position(|w| x <= w[1].ln())
        .unwrap_or(centers.len() - 2);
    let (x0, x1) = (centers[i].ln(), centers[i + 1].ln());
    let t = ((x - x0) / (x1 - x0)).clamp(0.0, 1.0);
    gains[i] + t * (gains[i + 1] - gains[i])
}

struct Deviation {
    /// Largest |response − target| between the first and last usable center (signed).
    between: f64,
    at_hz: f64,
    /// Largest |response − slider| at the centers (signed).
    centers: f64,
}

fn deviation(bands: GraphicBands, gains: &[f64], fs: u32) -> Deviation {
    let usable: Vec<f64> = bands
        .center_frequencies()
        .iter()
        .copied()
        .filter(|&f| f <= 0.49 * fs as f64)
        .collect();
    let gains = &gains[..usable.len()];
    let (lo, hi) = (usable[0].ln(), usable[usable.len() - 1].ln());
    let grid: Vec<f64> = (0..=2000)
        .map(|i| (lo + (hi - lo) * i as f64 / 2000.0).exp())
        .collect();
    let cfg = graphic(bands, gains.to_vec());
    let r = dsp_response_at(&cfg, fs, &grid);
    let mut d = Deviation {
        between: 0.0,
        at_hz: 0.0,
        centers: 0.0,
    };
    for (&f, &m) in grid.iter().zip(&r.magnitude_db) {
        let e = m - target(&usable, gains, f);
        if e.abs() > d.between.abs() {
            d.between = e;
            d.at_hz = f;
        }
    }
    let rc = dsp_response_at(&cfg, fs, &usable);
    for ((m, g), _) in rc.magnitude_db.iter().zip(gains).zip(&usable) {
        if (m - g).abs() > d.centers.abs() {
            d.centers = m - g;
        }
    }
    d
}

/// The smooth curves the accuracy targets cover: all presets, plateaus ±6/±12 and every single band
/// at ±6/±12.
fn smooth_cases(bands: GraphicBands) -> Vec<(String, Vec<f64>)> {
    let n = bands.center_frequencies().len();
    let mut cases = Vec::new();
    for (name, g) in PRESETS {
        let gains = match bands {
            GraphicBands::Ten => g.to_vec(),
            GraphicBands::ThirtyOne => resample(&g, GraphicBands::Ten, bands),
        };
        cases.push((format!("preset {name}"), gains));
    }
    for v in [6.0, -6.0, 12.0, -12.0] {
        cases.push((format!("plateau {v:+}"), vec![v; n]));
        for b in 0..n {
            let mut gains = vec![0.0; n];
            gains[b] = v;
            cases.push((
                format!("single {v:+} @ {} Hz", bands.center_frequencies()[b]),
                gains,
            ));
        }
    }
    cases
}

fn zigzag(n: usize, v: f64) -> Vec<f64> {
    (0..n).map(|i| if i % 2 == 0 { v } else { -v }).collect()
}

/// Accuracy limits (dB). The single-band ±12 dB triangle next to the top band at 44.1/48 kHz is
/// the one smooth case that does not reach 0.5 dB: its ramp ends in a peak at the last center, and
/// the top filter (≥ 0.36·fs) has no room above it to shape that corner.
fn between_limit(fs: u32) -> f64 {
    if fs >= 88_200 { 0.5 } else { 0.6 }
}
const CENTER_LIMIT: f64 = 0.3;

#[test]
fn dsp_graphic_accuracy_table() {
    println!(
        "worst deviation from the slider curve (dB), smooth curves / centers / zig-zag ±6, ±12:"
    );
    for bands in [GraphicBands::Ten, GraphicBands::ThirtyOne] {
        let cases = smooth_cases(bands);
        let n = bands.center_frequencies().len();
        for fs in RATES {
            let mut worst = (0.0f64, String::new(), 0.0);
            let mut worst_center = (0.0f64, String::new());
            let mut worst_preset = 0.0f64;
            for (name, gains) in &cases {
                let d = deviation(bands, gains, fs);
                if name.starts_with("preset") && d.between.abs() > worst_preset.abs() {
                    worst_preset = d.between;
                }
                if d.between.abs() > worst.0.abs() {
                    worst = (d.between, name.clone(), d.at_hz);
                }
                if d.centers.abs() > worst_center.0.abs() {
                    worst_center = (d.centers, name.clone());
                }
                assert!(
                    d.between.abs() <= between_limit(fs) && d.centers.abs() <= CENTER_LIMIT,
                    "{bands:?} @ {fs}: {name}: {:.3} dB at {:.0} Hz, centers {:.3} dB",
                    d.between,
                    d.at_hz,
                    d.centers
                );
            }
            let z6 = deviation(bands, &zigzag(n, 6.0), fs);
            let z12 = deviation(bands, &zigzag(n, 12.0), fs);
            println!(
                "{bands:?} @ {fs:>6}: smooth {:+.3} ({} @ {:.0} Hz), presets {:+.3}, centers {:+.3} ({}) | zig-zag ±6 {:+.3} / centers {:+.3}, ±12 {:+.3} / centers {:+.3}",
                worst.0,
                worst.1,
                worst.2,
                worst_preset,
                worst_center.0,
                worst_center.1,
                z6.between,
                z6.centers,
                z12.between,
                z12.centers
            );
            // Zig-zag patterns cannot follow straight lines between alternating centers, but the
            // centers themselves stay accurate.
            assert!(z12.centers.abs() <= CENTER_LIMIT && z12.between.abs() <= 1.5);
        }
    }
}

#[test]
fn dsp_graphic_random_settings_stay_close_at_the_centers() {
    let mut worst = 0.0f64;
    for bands in [GraphicBands::Ten, GraphicBands::ThirtyOne] {
        let centers = bands.center_frequencies();
        for fs in [44_100u32, 96_000] {
            for seed in 1..=6u64 {
                let mut rng = Rng::new(seed * 104_729 + centers.len() as u64);
                let gains: Vec<f64> = centers.iter().map(|_| rng.range(-12.0, 12.0)).collect();
                let d = deviation(bands, &gains, fs);
                worst = worst.max(d.centers.abs());
                assert!(
                    d.centers.abs() <= 0.5,
                    "{bands:?} @ {fs} seed {seed}: {:.3}",
                    d.centers
                );
            }
        }
    }
    println!("random ±12 dB settings: worst center error {worst:.3} dB");
}

/// Time of one solve on the control thread.
fn solve_time(bands: GraphicBands, fs: u32, repeats: usize) -> f64 {
    let n = bands.center_frequencies().len();
    let mut rng = Rng::new(99);
    let configs: Vec<Vec<f64>> = (0..repeats)
        .map(|_| (0..n).map(|_| rng.range(-12.0, 12.0)).collect())
        .collect();
    let start = Instant::now();
    for gains in &configs {
        std::hint::black_box(graphic_filters(bands, gains, fs));
    }
    start.elapsed().as_secs_f64() * 1e3 / repeats as f64
}

#[test]
fn dsp_graphic_solve_is_fast() {
    // Debug builds are ~20× slower than release; this only guards against regressions there.
    let ten = solve_time(GraphicBands::Ten, 48_000, 5);
    let thirty = solve_time(GraphicBands::ThirtyOne, 48_000, 3);
    println!("graphic solve: 10 bands {ten:.2} ms, 31 bands {thirty:.2} ms (this build)");
    let limit = if cfg!(debug_assertions) { 250.0 } else { 5.0 };
    assert!(thirty < limit && ten < limit);
}

/// Multi-sine through the running chain: the measured magnitude equals `dsp_response` (EQ +
/// bass shelf + effective preamp) within 0.1 dB.
#[test]
fn dsp_graphic_measured_multisine_matches_response() {
    for (bands, fs, bass) in [
        (GraphicBands::Ten, 44_100u32, false),
        (GraphicBands::ThirtyOne, 48_000, false),
        (GraphicBands::Ten, 96_000, true),
    ] {
        let n = bands.center_frequencies().len();
        let mut rng = Rng::new(5 + n as u64);
        let gains: Vec<f64> = (0..n).map(|_| rng.range(-9.0, 9.0)).collect();
        let mut cfg = graphic(bands, gains);
        cfg.eq.auto_headroom = true;
        if bass {
            cfg.bass = BassEnhancerConfig {
                enabled: true,
                boost_db: 6.0,
                frequency_hz: 90.0,
                harmonics: 0.0, // the harmonics are nonlinear and not part of the response
            };
        }
        measure_multisine(&cfg, fs);
    }
}

fn measure_multisine(cfg: &DspConfig, fs: u32) {
    let window = 1usize << 16;
    let pre_roll = 2 * fs as usize; // lets the slowest band's transient decay to < −120 dB
    let bin = fs as f64 / window as f64;
    // Exact DFT bins (no leakage with a rectangular window), log-spaced from 25 Hz to 19 kHz.
    let mut bins: Vec<usize> = (0..48)
        .map(|i| (25.0 * (19_000.0f64 / 25.0).powf(i as f64 / 47.0) / bin).round() as usize)
        .collect();
    bins.dedup();
    let mut rng = Rng::new(17);
    let phases: Vec<f64> = bins.iter().map(|_| rng.range(0.0, TAU)).collect();
    let amp = 0.02 / (bins.len() as f64).sqrt();
    let total = pre_roll + window;
    let mut buf = vec![0.0; 2 * total];
    for (fr, i) in buf.as_chunks_mut::<2>().0.iter_mut().zip(0..) {
        let t = i as f64;
        let v: f64 = bins
            .iter()
            .zip(&phases)
            .map(|(&k, &p)| amp * (TAU * k as f64 * t / window as f64 + p).sin())
            .sum();
        *fr = [v, v];
    }
    let mut chain = DspChain::new(fs);
    chain.set_config(cfg);
    settle(&mut chain, 1.0);
    for block in buf.chunks_mut(1024) {
        chain.process(block);
    }
    let out: Vec<f64> = buf.as_chunks::<2>().0[pre_roll..]
        .iter()
        .map(|f| f[0])
        .collect();
    let freqs: Vec<f64> = bins.iter().map(|&k| k as f64 * bin).collect();
    let expect = dsp_response_at(cfg, fs, &freqs);
    let mut worst = 0.0f64;
    for ((&k, &f), &e) in bins.iter().zip(&freqs).zip(&expect.magnitude_db) {
        let w = TAU * k as f64 / window as f64;
        let (mut re, mut im) = (0.0, 0.0);
        for (n, &y) in out.iter().enumerate() {
            let (s, c) = (w * (n % window) as f64).sin_cos();
            re += y * c;
            im += y * s;
        }
        let measured = db(2.0 * (re * re + im * im).sqrt() / window as f64 / amp);
        worst = worst.max((measured - e).abs());
        assert!(
            (measured - e).abs() <= 0.1,
            "fs={fs} f={f:.1}: measured {measured:.4} dB, response {e:.4} dB"
        );
    }
    println!(
        "multi-sine @ {fs} ({} tones, bass {}): worst |measured − response| = {worst:.2e} dB",
        bins.len(),
        cfg.bass.enabled
    );
}

// ------------------------------------------------------------------------------------------------
// Golden fixture shared with `src/features/equalizer/eqMath.test.ts`.
// ------------------------------------------------------------------------------------------------

const GOLDEN_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/features/equalizer/eqGolden.json"
);
const GOLDEN_POINTS: usize = 48;

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Golden {
    comment: String,
    presets: Vec<GoldenPreset>,
    cases: Vec<GoldenCase>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GoldenPreset {
    id: String,
    gains_db: Vec<f64>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GoldenFilter {
    freq_hz: f64,
    gain_db: f64,
    q: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    name: String,
    sample_rate: u32,
    config: DspConfig,
    filters: Vec<GoldenFilter>,
    points: usize,
    magnitude_db: Vec<f64>,
    max_boost_db: f64,
    effective_preamp_db: f64,
}

fn golden_configs() -> Vec<(String, u32, DspConfig)> {
    let rock = PRESETS.iter().find(|p| p.0 == "rock").unwrap().1.to_vec();
    let mut cases = vec![
        (
            "rock 10-band".to_string(),
            44_100,
            graphic(GraphicBands::Ten, rock.clone()),
        ),
        (
            "rock 31-band".to_string(),
            48_000,
            graphic(
                GraphicBands::ThirtyOne,
                resample(&rock, GraphicBands::Ten, GraphicBands::ThirtyOne),
            ),
        ),
        (
            "plateau +12, 10-band".to_string(),
            96_000,
            graphic(GraphicBands::Ten, vec![12.0; 10]),
        ),
        (
            "single -12 @ 16 kHz, 31-band".to_string(),
            44_100,
            graphic(GraphicBands::ThirtyOne, {
                let mut g = vec![0.0; 31];
                g[29] = -12.0;
                g
            }),
        ),
        (
            "zig-zag ±12, 10-band".to_string(),
            192_000,
            graphic(GraphicBands::Ten, zigzag(10, 12.0)),
        ),
    ];
    let mut with_bass = graphic(
        GraphicBands::Ten,
        vec![3.0, 3.0, 2.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    );
    with_bass.eq.auto_headroom = true;
    with_bass.eq.preamp_db = -1.5;
    with_bass.bass = BassEnhancerConfig {
        enabled: true,
        boost_db: 6.0,
        frequency_hz: 80.0,
        harmonics: 0.4,
    };
    cases.push((
        "deep bass + bass shelf, auto headroom".to_string(),
        48_000,
        with_bass,
    ));
    cases
}

fn golden_now() -> Golden {
    let cases = golden_configs()
        .into_iter()
        .map(|(name, fs, config)| {
            let musify_audio::api::EqMode::Graphic { bands, gains_db } = &config.eq.mode else {
                unreachable!()
            };
            let filters = graphic_filters(*bands, gains_db, fs)
                .iter()
                .map(|s| GoldenFilter {
                    freq_hz: s.freq_hz,
                    gain_db: s.gain_db,
                    q: s.q,
                })
                .collect();
            let r = dsp_response(&config, fs, GOLDEN_POINTS);
            GoldenCase {
                name,
                sample_rate: fs,
                config,
                filters,
                points: GOLDEN_POINTS,
                magnitude_db: r.magnitude_db,
                max_boost_db: r.max_boost_db,
                effective_preamp_db: r.effective_preamp_db,
            }
        })
        .collect();
    Golden {
        comment: "Generated by `cargo test -p musify-audio --test dsp_graphic -- --ignored write_graphic_golden`. Do not edit: the Rust engine and eqMath.ts must both reproduce it.".to_string(),
        presets: PRESETS
            .iter()
            .map(|(id, g)| GoldenPreset {
                id: id.to_string(),
                gains_db: g.to_vec(),
            })
            .collect(),
        cases,
    }
}

#[test]
#[ignore]
fn write_graphic_golden() {
    let json = serde_json::to_string_pretty(&golden_now()).unwrap();
    std::fs::write(GOLDEN_PATH, json + "\n").unwrap();
    println!("wrote {GOLDEN_PATH}");
}

#[test]
fn dsp_graphic_matches_golden_fixture() {
    let text = std::fs::read_to_string(GOLDEN_PATH).expect("golden fixture");
    let golden: Golden = serde_json::from_str(&text).unwrap();
    let now = golden_now();
    assert_eq!(golden.presets.len(), now.presets.len());
    for (a, b) in golden.presets.iter().zip(&now.presets) {
        assert_eq!((&a.id, &a.gains_db), (&b.id, &b.gains_db));
    }
    assert_eq!(golden.cases.len(), now.cases.len());
    for (g, n) in golden.cases.iter().zip(&now.cases) {
        assert_eq!(g.config, n.config, "{}", g.name);
        assert_eq!(g.filters.len(), n.filters.len(), "{}", g.name);
        for (a, b) in g.filters.iter().zip(&n.filters) {
            assert!((a.freq_hz - b.freq_hz).abs() < 1e-9 && (a.q - b.q).abs() < 1e-9);
            assert!(
                (a.gain_db - b.gain_db).abs() < 1e-6,
                "{}: {a:?} vs {b:?}",
                g.name
            );
        }
        for (a, b) in g.magnitude_db.iter().zip(&n.magnitude_db) {
            assert!((a - b).abs() < 1e-6, "{}: {a} vs {b}", g.name);
        }
        assert!((g.max_boost_db - n.max_boost_db).abs() < 1e-6);
        assert!((g.effective_preamp_db - n.effective_preamp_db).abs() < 1e-6);
    }
}

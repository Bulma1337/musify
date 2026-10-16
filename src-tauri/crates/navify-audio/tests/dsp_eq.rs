//! EQ accuracy: graphic band-interaction correction, response vs. the running chain, auto headroom.

mod dsp_common;

use dsp_common::*;
use navify_audio::api::{
    BassEnhancerConfig, DspConfig, EqConfig, EqMode, FilterKind, GraphicBands,
};
use navify_audio::dsp::{DspChain, dsp_response, dsp_response_at, eq_response};

#[test]
fn dsp_graphic_eq_hits_every_slider_value() {
    let mut worst = 0.0f64;
    for bands in [GraphicBands::Ten, GraphicBands::ThirtyOne] {
        let centers = bands.center_frequencies();
        for fs in [44_100u32, 96_000] {
            for seed in 1..=8u64 {
                let mut rng = Rng::new(seed * 7919 + centers.len() as u64);
                let gains: Vec<f64> = centers.iter().map(|_| rng.range(-12.0, 12.0)).collect();
                let cfg = graphic(bands, gains.clone());
                let r = dsp_response_at(&cfg, fs, centers);
                assert_eq!(r.effective_preamp_db, 0.0);
                for ((&f, &m), &g) in centers.iter().zip(&r.magnitude_db).zip(&gains) {
                    let e = (m - g).abs();
                    worst = worst.max(e);
                    assert!(
                        e <= 0.3,
                        "{bands:?} fs={fs} seed={seed} f={f}: {m:.3} dB vs slider {g:.3}"
                    );
                }
            }
        }
    }
    println!("graphic EQ worst center error: {worst:.2e} dB");
}

#[test]
fn dsp_graphic_eq_extreme_patterns() {
    // Alternating ±12 dB is the worst case for band interaction.
    for bands in [GraphicBands::Ten, GraphicBands::ThirtyOne] {
        let centers = bands.center_frequencies();
        let gains: Vec<f64> = (0..centers.len())
            .map(|i| if i % 2 == 0 { 12.0 } else { -12.0 })
            .collect();
        for fs in [44_100u32, 48_000, 192_000] {
            let r = dsp_response_at(&graphic(bands, gains.clone()), fs, centers);
            let worst = r
                .magnitude_db
                .iter()
                .zip(&gains)
                .map(|(m, g)| (m - g).abs())
                .fold(0.0, f64::max);
            println!("{bands:?} alternating ±12 @ {fs}: worst {worst:.3} dB");
            assert!(worst <= 0.3);
        }
    }
}

/// The running chain (measured impulse response) matches the slider values at the centers.
#[test]
fn dsp_graphic_eq_measured() {
    let fs = 48_000u32;
    let bands = GraphicBands::ThirtyOne;
    let centers = bands.center_frequencies();
    let mut rng = Rng::new(42);
    let gains: Vec<f64> = centers.iter().map(|_| rng.range(-12.0, 12.0)).collect();
    let mut chain = DspChain::new(fs);
    chain.set_config(&graphic(bands, gains.clone()));
    settle(&mut chain, 1.0);
    let ir = impulse_response(&mut chain, 1 << 17, 0.01);
    let mut worst = 0.0f64;
    for (&f, &g) in centers.iter().zip(&gains) {
        let m = dtft_db(&ir, fs as f64, f);
        worst = worst.max((m - g).abs());
        assert!(
            (m - g).abs() <= 0.3,
            "f={f}: measured {m:.3} vs slider {g:.3}"
        );
    }
    println!("graphic EQ measured worst center error: {worst:.3} dB");
}

fn parametric_profile() -> DspConfig {
    parametric(
        vec![
            pf(FilterKind::HighPass, 25.0, 0.0, 0.7),
            pf(FilterKind::LowShelf, 105.0, 5.5, 0.7),
            pf(FilterKind::Peaking, 180.0, -3.2, 1.2),
            pf(FilterKind::Peaking, 2_900.0, 4.0, 2.5),
            pf(FilterKind::Notch, 6_100.0, 0.0, 8.0),
            pf(FilterKind::HighShelf, 10_000.0, -2.5, 0.7),
            pf(FilterKind::LowPass, 19_000.0, 0.0, 0.9),
            navify_audio::api::ParametricFilter {
                enabled: false,
                kind: FilterKind::Peaking,
                freq_hz: 500.0,
                gain_db: 12.0,
                q: 1.0,
            },
        ],
        -1.5,
        true,
    )
}

#[test]
fn dsp_parametric_response_matches_running_chain() {
    for fs in [44_100u32, 96_000] {
        let cfg = parametric_profile();
        let resp = eq_response(&cfg.eq, fs, 400);
        let mut chain = DspChain::new(fs);
        chain.set_config(&cfg);
        settle(&mut chain, 1.0);
        let ir = impulse_response(&mut chain, 1 << 17, 0.01);
        let mut worst = 0.0f64;
        for (&f, &expect) in resp.frequencies.iter().zip(&resp.magnitude_db) {
            if !(30.0..=18_000.0).contains(&f) || expect < -40.0 {
                continue; // inside the notch the dB value is ill-conditioned
            }
            let m = dtft_db(&ir, fs as f64, f);
            worst = worst.max((m - expect).abs());
            assert!(
                (m - expect).abs() <= 0.1,
                "fs={fs} f={f:.1}: measured {m:.4} vs response {expect:.4}"
            );
        }
        println!(
            "parametric @ {fs}: worst |measured − eq_response| = {worst:.2e} dB, preamp {:.3} dB",
            resp.effective_preamp_db
        );
    }
}

#[test]
fn dsp_auto_headroom_keeps_response_below_zero() {
    let fs = 48_000u32;
    let mut rng = Rng::new(7);
    for i in 0..60 {
        let mut cfg = if i % 2 == 0 {
            let bands = if i % 4 == 0 {
                GraphicBands::Ten
            } else {
                GraphicBands::ThirtyOne
            };
            graphic(
                bands,
                bands
                    .center_frequencies()
                    .iter()
                    .map(|_| rng.range(-12.0, 12.0))
                    .collect(),
            )
        } else {
            let filters = (0..1 + (rng.unit() * 8.0) as usize)
                .map(|_| {
                    let kind = [
                        FilterKind::Peaking,
                        FilterKind::LowShelf,
                        FilterKind::HighShelf,
                    ][(rng.unit() * 3.0) as usize];
                    pf(
                        kind,
                        20.0 * 1000f64.powf(rng.unit()),
                        rng.range(-12.0, 15.0),
                        rng.range(0.3, 12.0),
                    )
                })
                .collect();
            parametric(filters, 0.0, true)
        };
        cfg.eq.auto_headroom = true;
        cfg.eq.preamp_db = -rng.range(0.0, 3.0) * (i % 3) as f64;
        if i % 5 == 0 {
            cfg.bass = BassEnhancerConfig {
                enabled: true,
                boost_db: rng.range(0.0, 12.0),
                frequency_hz: rng.range(40.0, 150.0),
                harmonics: 0.3,
            };
        }
        let r = dsp_response(&cfg, fs, 8192);
        let max = r
            .magnitude_db
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            max <= 0.01,
            "config {i}: response max {max:.4} dB (max boost {:.3})",
            r.max_boost_db
        );
        assert!(r.effective_preamp_db <= cfg.eq.preamp_db + 1e-12);
    }
}

#[test]
fn dsp_response_reports_preamp_and_boost() {
    let cfg = parametric(vec![pf(FilterKind::Peaking, 1000.0, 6.0, 1.0)], -2.0, true);
    let r = eq_response(&cfg.eq, 48_000, 512);
    assert_eq!(r.frequencies.len(), 512);
    assert!((r.frequencies[0] - 20.0).abs() < 1e-9 && (r.frequencies[511] - 20_000.0).abs() < 1e-6);
    assert!((r.max_boost_db - 6.0).abs() < 1e-6);
    assert!((r.effective_preamp_db - (-8.0)).abs() < 1e-6);
    // Without auto headroom, the preamp is the manual one.
    let mut manual = cfg.clone();
    manual.eq.auto_headroom = false;
    assert_eq!(
        eq_response(&manual.eq, 48_000, 16).effective_preamp_db,
        -2.0
    );
    // A disabled EQ is flat.
    let off = EqConfig {
        enabled: false,
        ..cfg.eq.clone()
    };
    let r = eq_response(&off, 48_000, 64);
    assert!(r.magnitude_db.iter().all(|&m| m == 0.0));
    // Bass shelf boost counts towards the headroom.
    let mut with_bass = DspConfig {
        eq: EqConfig {
            enabled: false,
            ..EqConfig::default()
        },
        ..DspConfig::default()
    };
    with_bass.bass = BassEnhancerConfig {
        enabled: true,
        boost_db: 6.0,
        frequency_hz: 80.0,
        harmonics: 0.3,
    };
    let r = dsp_response(&with_bass, 48_000, 512);
    assert!((r.effective_preamp_db + r.max_boost_db).abs() < 1e-9 && r.max_boost_db > 5.9);
    let _ = EqMode::Parametric { filters: vec![] };
}

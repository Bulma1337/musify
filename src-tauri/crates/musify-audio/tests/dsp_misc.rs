//! Bypass bit-exactness, stereo math, volume curve, loudness, bass enhancer, AutoEQ import,
//! robustness and the peak meter.

mod dsp_common;

use std::f64::consts::{FRAC_1_SQRT_2, PI, SQRT_2};

use dsp_common::*;
use musify_audio::api::{
    BassEnhancerConfig, DspConfig, EqMode, FilterKind, GraphicBands, StereoConfig,
};
use musify_audio::dsp::{DspChain, loudness_boost_db, parse_autoeq, volume_to_gain};

fn noise(seed: u64, frames: usize) -> Vec<f64> {
    let mut rng = Rng::new(seed);
    (0..2 * frames)
        .map(|i| match i % 7 {
            0 => rng.range(-1.0, 1.0) * 1e-12, // tiny values
            1 => rng.range(-1.5, 1.5),         // over full scale
            _ => rng.range(-1.0, 1.0),
        })
        .collect()
}

fn run(chain: &mut DspChain, input: &[f64], block: usize) -> Vec<f64> {
    let mut out = input.to_vec();
    for b in out.chunks_mut(2 * block) {
        chain.process(b);
    }
    out
}

fn bit_identical(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

#[test]
fn dsp_bypass_is_bit_exact() {
    for fs in [44_100u32, 96_000, 384_000] {
        let input = noise(fs as u64, 20_000);
        let mut chain = DspChain::new(fs);
        assert!(
            bit_identical(&run(&mut chain, &input, 512), &input),
            "fresh chain"
        );
        chain.set_config(&DspConfig::default());
        chain.set_volume(volume_to_gain(1.0));
        assert!(
            bit_identical(&run(&mut chain, &input, 333), &input),
            "default config, volume 1.0"
        );
        assert_eq!(chain.latency_frames(), 0);

        // Turn everything on, then back off: once the glides finish, bypass is bit-exact again.
        let mut busy = graphic(GraphicBands::ThirtyOne, vec![3.0; 31]);
        busy.bass.enabled = true;
        busy.loudness_compensation = true;
        busy.stereo = StereoConfig {
            width: 1.5,
            mono: false,
            balance: 0.3,
        };
        busy.limiter = true;
        chain.set_config(&busy);
        chain.set_volume(0.5);
        run(&mut chain, &input, 256);
        chain.set_config(&DspConfig::default());
        chain.set_volume(1.0);
        settle(&mut chain, 1.5);
        assert!(
            bit_identical(&run(&mut chain, &input, 100), &input),
            "after returning to bypass @ {fs}"
        );
    }
}

#[test]
fn dsp_stereo_mono_balance_width() {
    let fs = 48_000;
    let input = noise(9, 4_000);
    let settled = |cfg: StereoConfig| {
        let mut chain = DspChain::new(fs);
        chain.set_config(&DspConfig {
            stereo: cfg,
            ..DspConfig::default()
        });
        chain.reset();
        run(&mut chain, &input, 512)
    };
    let mono = settled(StereoConfig {
        width: 1.0,
        mono: true,
        balance: 0.0,
    });
    for (o, i) in mono
        .as_chunks::<2>()
        .0
        .iter()
        .zip(input.as_chunks::<2>().0.iter())
    {
        let m = (i[0] + i[1]) / 2.0;
        assert!((o[0] - m).abs() < 1e-15 && (o[1] - m).abs() < 1e-15);
    }
    let right = settled(StereoConfig {
        width: 1.0,
        mono: false,
        balance: 1.0,
    });
    for (o, i) in right
        .as_chunks::<2>()
        .0
        .iter()
        .zip(input.as_chunks::<2>().0.iter())
    {
        assert_eq!(o[0], 0.0);
        assert!((o[1] - SQRT_2 * i[1]).abs() < 1e-15);
    }
    let half = settled(StereoConfig {
        width: 1.0,
        mono: false,
        balance: -0.5,
    });
    let (gl, gr) = ((PI / 8.0).cos() * SQRT_2, (PI / 8.0).sin() * SQRT_2);
    for (o, i) in half
        .as_chunks::<2>()
        .0
        .iter()
        .zip(input.as_chunks::<2>().0.iter())
    {
        assert!((o[0] - gl * i[0]).abs() < 1e-14 && (o[1] - gr * i[1]).abs() < 1e-14);
    }
    assert!((gl * gl + gr * gr - 2.0).abs() < 1e-12, "constant power");
    let wide = settled(StereoConfig {
        width: 2.0,
        mono: false,
        balance: 0.0,
    });
    for (o, i) in wide
        .as_chunks::<2>()
        .0
        .iter()
        .zip(input.as_chunks::<2>().0.iter())
    {
        let (m, s) = ((i[0] + i[1]) / 2.0, (i[0] - i[1]) / 2.0);
        assert!((o[0] - (m + 2.0 * s)).abs() < 1e-14 && (o[1] - (m - 2.0 * s)).abs() < 1e-14);
    }
    let zero = settled(StereoConfig {
        width: 0.0,
        mono: false,
        balance: 0.0,
    });
    assert!(bit_identical(&zero, &mono), "width 0 equals mono");
}

#[test]
fn dsp_volume_curve() {
    assert_eq!(volume_to_gain(0.0), 0.0);
    assert_eq!(volume_to_gain(1.0), 1.0);
    assert_eq!(volume_to_gain(-1.0), 0.0);
    assert_eq!(volume_to_gain(f64::NAN), 0.0);
    assert_eq!(volume_to_gain(2.0), 1.0);
    let mut last = 0.0;
    for i in 1..=10_000 {
        let g = volume_to_gain(i as f64 / 10_000.0);
        assert!(g > last, "monotonic at {i}");
        last = g;
    }
    assert!((db(volume_to_gain(0.5)) + 30.0).abs() < 1e-9);
    assert!((db(volume_to_gain(0.05)) + 57.0).abs() < 1e-9);
    assert!(db(volume_to_gain(0.01)) < -70.0);
}

#[test]
fn dsp_volume_is_smoothed_and_exact() {
    let fs = 48_000;
    let mut chain = DspChain::new(fs);
    let ones = vec![1.0; 2 * 48_000];
    chain.set_volume(0.25);
    let out = run(&mut chain, &ones, 480);
    // Continuous: no step larger than a fraction of a dB between frames.
    for w in out.as_chunks::<2>().0.iter().collect::<Vec<_>>().windows(2) {
        assert!((w[1][0] - w[0][0]).abs() < 0.01);
    }
    assert_eq!(out[out.len() - 1], 0.25, "settles exactly");
    // ~20 ms time constant: 63 % of the way after ≈ 20 ms.
    let at20 = out[2 * 960];
    assert!(at20 > 0.4 && at20 < 0.6, "{at20}");
}

#[test]
fn dsp_peak_meter() {
    let mut chain = DspChain::new(48_000);
    assert_eq!(chain.take_peak_db(), -120.0);
    let mut buf = vec![0.0; 64];
    buf[10] = -0.5;
    chain.process(&mut buf);
    assert!((chain.take_peak_db() + 6.0206).abs() < 1e-3);
    assert_eq!(chain.take_peak_db(), -120.0, "reset on read");
    // The meter reads before the limiter.
    chain.set_config(&DspConfig {
        limiter: true,
        ..DspConfig::default()
    });
    let mut buf = vec![2.0; 64];
    chain.process(&mut buf);
    assert!((chain.take_peak_db() - 6.0206).abs() < 1e-3);
}

#[test]
fn dsp_survives_nan_and_inf() {
    let fs = 48_000;
    let mut cfg = graphic(
        GraphicBands::Ten,
        vec![6.0, -3.0, 2.0, 0.0, 1.0, 0.0, -2.0, 4.0, 3.0, 1.0],
    );
    cfg.bass = BassEnhancerConfig {
        enabled: true,
        boost_db: 6.0,
        frequency_hz: 80.0,
        harmonics: 0.5,
    };
    cfg.loudness_compensation = true;
    cfg.limiter = true;
    let mut chain = DspChain::new(fs);
    chain.set_config(&cfg);
    chain.set_volume(0.5);
    let mut sig: Vec<f64> = (0..2 * 9_600)
        .map(|i| 0.3 * (i as f64 * 0.01).sin())
        .collect();
    sig[2_000] = f64::NAN;
    sig[2_001] = f64::INFINITY;
    sig[4_000] = f64::NEG_INFINITY;
    sig[5_000] = 1e300;
    let out = run(&mut chain, &sig, 480);
    assert!(out.iter().all(|v| v.is_finite()));
    let tail = run(&mut chain, &vec![0.0; 2 * 48_000], 480);
    let last = tail[tail.len() - 2_000..]
        .iter()
        .fold(0.0f64, |p, v| p.max(v.abs()));
    assert!(
        last < 1e-6,
        "state decays normally after bad input ({last})"
    );
    chain.set_volume(f64::NAN);
    chain.process(&mut sig[..64]);
}

#[test]
fn dsp_every_rate_and_odd_blocks() {
    let mut cfg = graphic(
        GraphicBands::ThirtyOne,
        (0..31).map(|i| ((i * 7) % 13) as f64 - 6.0).collect(),
    );
    cfg.bass.enabled = true;
    cfg.loudness_compensation = true;
    cfg.limiter = true;
    for fs in [
        44_100u32, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000,
    ] {
        let mut chain = DspChain::new(fs);
        chain.set_config(&cfg);
        chain.set_volume(0.3);
        let input: Vec<f64> = (0..2 * 20_000)
            .map(|i| 0.5 * ((i / 2) as f64 * 2.0 * PI * 1000.0 / fs as f64).sin())
            .collect();
        let mut out = input.clone();
        let mut pos = 0;
        for (k, n) in [1usize, 7, 31, 32, 33, 100, 1023]
            .iter()
            .cycle()
            .enumerate()
        {
            if pos >= out.len() || k > 10_000 {
                break;
            }
            let end = (pos + 2 * n).min(out.len());
            chain.process(&mut out[pos..end]);
            pos = end;
        }
        assert!(
            out.iter().all(|v| v.is_finite() && v.abs() < 1.0),
            "fs={fs}"
        );
    }
}

#[test]
fn dsp_loudness_compensation_tracks_volume() {
    let fs = 48_000u32;
    let vol = 0.1; // −20 dB
    let mut chain = DspChain::new(fs);
    chain.set_config(&DspConfig {
        loudness_compensation: true,
        ..DspConfig::default()
    });
    chain.set_volume(vol);
    chain.reset();
    let ir = impulse_response(&mut chain, 1 << 16, 0.01);
    let (lo, hi) = loudness_boost_db(vol);
    let at = |f: f64| dtft_db(&ir, fs as f64, f) - db(vol);
    println!(
        "loudness @ −20 dB: 20 Hz {:+.2}, 1 kHz {:+.2}, 20 kHz {:+.2} (targets {lo:+.2}/{hi:+.2})",
        at(20.0),
        at(1000.0),
        at(20_000.0)
    );
    assert!((at(20.0) - lo).abs() < 0.3);
    assert!(at(1000.0).abs() < 0.3);
    assert!((at(20_000.0) - hi).abs() < 0.5);
    // At full volume the stage is neutral (bit-exact path).
    let mut chain = DspChain::new(fs);
    chain.set_config(&DspConfig {
        loudness_compensation: true,
        ..DspConfig::default()
    });
    let input = noise(1, 1_000);
    assert!(bit_identical(&run(&mut chain, &input, 64), &input));
}

#[test]
fn dsp_bass_enhancer_generates_bounded_harmonics() {
    let fs = 48_000u32;
    let f0 = 50.0;
    let amp = 0.5;
    let mut chain = DspChain::new(fs);
    let bass = BassEnhancerConfig {
        enabled: true,
        boost_db: 0.0,
        frequency_hz: 80.0,
        harmonics: 1.0,
    };
    chain.set_config(&DspConfig {
        bass,
        ..DspConfig::default()
    });
    chain.reset();
    let n = 4 * fs as usize;
    let input: Vec<f64> = (0..n)
        .flat_map(|i| {
            let v = amp * (2.0 * PI * f0 * i as f64 / fs as f64).sin();
            [v, v]
        })
        .collect();
    let out = run(&mut chain, &input, 512);
    let tail: Vec<f64> = channel(&out, 0)[2 * fs as usize..].to_vec();
    let level = |f: f64| dtft_db(&tail, fs as f64, f) - db(tail.len() as f64 / 2.0);
    let (h1, h2, h3, h4) = (level(f0), level(2.0 * f0), level(3.0 * f0), level(5.0 * f0));
    println!(
        "bass enhancer: fundamental {h1:.1} dB, 2nd {h2:.1}, 3rd {h3:.1}, 5th {h4:.1} (input {:.1})",
        db(amp)
    );
    assert!((h1 - db(amp)).abs() < 1.5, "fundamental kept");
    assert!(
        h2 > db(amp) - 20.0 && h2 < db(amp) - 3.0,
        "2nd harmonic present but below the note"
    );
    assert!(
        h3 > db(amp) - 25.0 && h3 < db(amp) - 3.0,
        "3rd harmonic present"
    );
    assert!(h4 < h3 - 15.0, "no higher-order junk");
    let peak = tail.iter().fold(0.0f64, |p, v| p.max(v.abs()));
    assert!(
        db(peak) - db(amp) < 4.0,
        "peak rise {:.2} dB",
        db(peak) - db(amp)
    );
}

const AUTOEQ_PROFILE: &str = "Preamp: -6.2 dB\r\n\
Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70\r\n\
Filter 2: ON PK Fc 216 Hz Gain -2.4 dB Q 0.83\r\n\
Filter 3: ON PK Fc 1176 Hz Gain 1.6 dB Q 1.20\r\n\
Filter 4: ON PK Fc 2493 Hz Gain -3.1 dB Q 2.37\r\n\
Filter 5: ON PK Fc 3672 Hz Gain 4.2 dB Q 3.43\r\n\
Filter 6: ON PK Fc 5260 Hz Gain -4.0 dB Q 4.22\r\n\
Filter 7: ON PK Fc 6627 Hz Gain 2.8 dB Q 3.58\r\n\
Filter 8: ON PK Fc 8445 Hz Gain -2.1 dB Q 2.75\r\n\
Filter 9: ON HSC Fc 10000 Hz Gain -1.9 dB Q 0.70\r\n\
Filter 10: ON PK Fc 19733 Hz Gain -6.3 dB Q 0.43\r\n";

#[test]
fn dsp_autoeq_realistic_profile() {
    let eq = parse_autoeq(AUTOEQ_PROFILE).unwrap();
    assert!(eq.enabled && !eq.auto_headroom);
    assert_eq!(eq.preamp_db, -6.2);
    let EqMode::Parametric { filters } = &eq.mode else {
        panic!("parametric")
    };
    assert_eq!(filters.len(), 10);
    assert_eq!(filters[0].kind, FilterKind::LowShelf);
    assert_eq!(
        (filters[0].freq_hz, filters[0].gain_db, filters[0].q),
        (105.0, 5.5, 0.70)
    );
    assert_eq!(filters[8].kind, FilterKind::HighShelf);
    assert_eq!(
        (filters[9].freq_hz, filters[9].gain_db, filters[9].q),
        (19733.0, -6.3, 0.43)
    );
    assert!(filters.iter().all(|f| f.enabled));
}

#[test]
fn dsp_autoeq_tolerant_syntax() {
    let text = "\u{feff}# Equalizer APO config\n\
        preamp:   -3 dB  \n\
        Filter 1:  OFF  PK   Fc  100  Hz  Gain  2  dB  Q  1  \n\
        Filter 2: ON HP Fc 20 Hz\n\
        Filter 3: ON LP Fc 18000 Hz Q 0.5\n\
        Filter 4: ON NO Fc 6000 Hz\n\
        Filter: ON PK Fc 1000 Hz Gain -3 dB BW Oct 1.0 # inline comment\n\
        Filter 6: ON LS Fc 80 Hz Gain 4 dB\n\
        Device: Speakers\n\
        Preamp: -1.5 dB\n";
    let eq = parse_autoeq(text).unwrap();
    assert_eq!(eq.preamp_db, -4.5);
    let EqMode::Parametric { filters } = &eq.mode else {
        panic!()
    };
    assert_eq!(filters.len(), 6);
    assert!(!filters[0].enabled);
    assert_eq!(filters[1].kind, FilterKind::HighPass);
    assert!((filters[1].q - FRAC_1_SQRT_2).abs() < 1e-12);
    assert_eq!(filters[2].q, 0.5);
    assert_eq!(filters[3].kind, FilterKind::Notch);
    assert!((filters[4].q - SQRT_2).abs() < 1e-12, "BW 1 octave = Q √2");
    assert_eq!(filters[5].kind, FilterKind::LowShelf);

    assert!(parse_autoeq("").is_err());
    assert!(parse_autoeq("hello world").is_err());
    assert!(parse_autoeq("Filter 1: ON XX Fc 100 Hz Gain 1 dB Q 1").is_err());
    assert!(
        parse_autoeq("Filter 1: ON PK Fc 100 Hz Q 1").is_err(),
        "peaking without gain"
    );
    assert!(parse_autoeq("Filter 1: ON PK Fc abc Hz Gain 1 dB Q 1").is_err());
    assert!(parse_autoeq("Preamp: -3 dB").is_ok());
}

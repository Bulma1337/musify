//! True-peak limiter: output intersample peaks ≤ −1 dBTP (+0.1 dB) measured with an independent
//! 4× oversampled reference meter; reported latency equals the measured delay.

mod dsp_common;

use std::f64::consts::PI;

use dsp_common::*;
use musify_audio::api::DspConfig;
use musify_audio::dsp::{CEILING_DBTP, DspChain};

const TOLERANCE_DB: f64 = 0.1;

fn limited(fs: u32, input: &[f64], block: usize) -> (Vec<f64>, usize) {
    let mut chain = DspChain::new(fs);
    chain.set_config(&DspConfig {
        limiter: true,
        ..DspConfig::default()
    });
    chain.reset(); // limiter fully engaged from the first sample
    let mut out = input.to_vec();
    for b in out.chunks_mut(2 * block) {
        chain.process(b);
    }
    (out, chain.latency_frames())
}

#[derive(Clone, Copy, PartialEq)]
enum Meter {
    /// High-resolution 4× reference (128-tap-per-phase windowed sinc, flat to 0.48·fs).
    Precise,
    /// ITU-R BS.1770-4 Annex 2 (the normative dBTP definition).
    Bs1770,
}

fn meter(m: Meter, x: &[f64]) -> f64 {
    match m {
        Meter::Precise => true_peak_db(x),
        Meter::Bs1770 => true_peak_bs1770_db(x),
    }
}

fn check_with(name: &str, fs: u32, input: &[f64], m: Meter) -> f64 {
    // Flush the look-ahead with silence so the whole signal (including its abrupt end) comes out.
    let mut padded = input.to_vec();
    padded.resize(input.len() + 2 * 8192, 0.0);
    let (out, _) = limited(fs, &padded, 480);
    let tp = meter(m, &channel(&out, 0)).max(meter(m, &channel(&out, 1)));
    let tp_in = meter(m, &channel(input, 0)).max(meter(m, &channel(input, 1)));
    let other = if m == Meter::Precise {
        Meter::Bs1770
    } else {
        Meter::Precise
    };
    let tp_other = meter(other, &channel(&out, 0)).max(meter(other, &channel(&out, 1)));
    let label = |m: Meter| {
        if m == Meter::Precise {
            "precise"
        } else {
            "BS.1770"
        }
    };
    println!(
        "{name} @ {fs}: input {tp_in:+.2} dBTP → output {tp:+.3} dBTP ({}; {} meter: {tp_other:+.3})",
        label(m),
        label(other)
    );
    assert!(
        tp <= CEILING_DBTP + TOLERANCE_DB,
        "{name} @ {fs}: {tp:.3} dBTP"
    );
    tp
}

fn check(name: &str, fs: u32, input: &[f64]) -> f64 {
    check_with(name, fs, input, Meter::Precise)
}

fn stereo(len: usize, mut f: impl FnMut(usize) -> (f64, f64)) -> Vec<f64> {
    (0..len)
        .flat_map(|n| {
            let (l, r) = f(n);
            [l, r]
        })
        .collect()
}

#[test]
fn dsp_limiter_quarter_rate_sine_at_45_degrees() {
    // Samples are exactly ±1.0 (0 dBFS), the waveform peaks at +3.01 dBTP between them.
    for fs in [44_100u32, 48_000] {
        let x = stereo(fs as usize, |n| {
            let v = 2f64.sqrt() * (PI * n as f64 / 2.0 + PI / 4.0).sin();
            (v, -v)
        });
        let tp = check("fs/4 sine 45°", fs, &x);
        assert!(
            tp > CEILING_DBTP - 0.5,
            "limiter should not over-attenuate a steady tone ({tp:.3})"
        );
    }
}

#[test]
fn dsp_limiter_square_bursts() {
    // Naive (non-band-limited) square bursts at 0 dBFS: strong Gibbs overshoot between samples.
    for fs in [44_100u32, 96_000] {
        let period = 37;
        let x = stereo(fs as usize, |n| {
            let on = (n / (fs as usize / 20)).is_multiple_of(2);
            let v = if !on {
                0.0
            } else if (n / period).is_multiple_of(2) {
                1.0
            } else {
                -1.0
            };
            (v, 0.5 * v)
        });
        check("square bursts", fs, &x);
    }
}

/// Full-band white noise has content right up to Nyquist, where any finite 4× interpolator
/// (including the limiter's detector) under-reads; such content is judged with the normative
/// BS.1770-4 meter. Noise band-limited like real program material (anti-aliasing filter at 0.45·fs,
/// i.e. 19.8 kHz at 44.1 kHz) must also pass the high-resolution meter.
#[test]
fn dsp_limiter_full_scale_noise_plus_6db() {
    for fs in [44_100u32, 48_000] {
        let mut rng = Rng::new(3);
        let x = stereo(fs as usize, |_| {
            (2.0 * rng.range(-1.0, 1.0), 2.0 * rng.range(-1.0, 1.0))
        });
        check_with("white noise +6 dB", fs, &x, Meter::Bs1770);
        let mut rng = Rng::new(4);
        let x = stereo(fs as usize, |_| (0.7 * rng.gauss(), 0.7 * rng.gauss()));
        check_with("gaussian noise", fs, &x, Meter::Bs1770);
        let mut rng = Rng::new(5);
        let l = bandlimited_noise(&mut rng, fs as usize, 0.45);
        let r = bandlimited_noise(&mut rng, fs as usize, 0.45);
        let x: Vec<f64> = l
            .iter()
            .zip(&r)
            .flat_map(|(a, b)| [2.0 * a, 2.0 * b])
            .collect();
        check("band-limited noise +6 dB", fs, &x);
    }
}

#[test]
fn dsp_bs1770_reference_meter_is_sane() {
    // A 997 Hz sine at −6 dBFS reads −6 dBTP; the fs/4 45° sine reads ≈ +3 dBTP.
    let fs = 48_000.0;
    let x: Vec<f64> = (0..48_000)
        .map(|n| 0.5 * (2.0 * PI * 997.0 * n as f64 / fs).sin())
        .collect();
    assert!((true_peak_bs1770_db(&x) + 6.02).abs() < 0.05);
    let x: Vec<f64> = (0..4_800)
        .map(|n| 2f64.sqrt() * (PI * n as f64 / 2.0 + PI / 4.0).sin())
        .collect();
    assert!(
        (true_peak_bs1770_db(&x) - 3.01).abs() < 0.2,
        "{}",
        true_peak_bs1770_db(&x)
    );
}

#[test]
fn dsp_limiter_sweep_and_transients() {
    let fs = 48_000u32;
    let len = 2 * fs as usize;
    // Log sweep 20 Hz → 20 kHz at +6 dBFS with an abrupt level jump every 100 ms.
    let x = stereo(len, |n| {
        let t = n as f64 / fs as f64;
        let k = (1000f64).ln() / 2.0;
        let phase = 2.0 * PI * 20.0 * ((k * t).exp() - 1.0) / k;
        let level = if (n / 4800).is_multiple_of(2) {
            2.0
        } else {
            0.3
        };
        (level * phase.sin(), level * (phase + 1.0).sin())
    });
    check("sweep +6 dB", fs, &x);
    // Single full-scale clicks after silence (needs the full look-ahead).
    let x = stereo(len, |n| {
        if n % 9_000 == 4_000 {
            (4.0, -4.0)
        } else {
            (0.0, 0.0)
        }
    });
    check("clicks +12 dB", fs, &x);
}

#[test]
fn dsp_limiter_latency_matches_measured_delay() {
    for fs in [44_100u32, 48_000, 96_000, 192_000, 384_000] {
        let mut x = vec![0.0; 2 * 4096];
        x[2 * 10] = 0.5;
        x[2 * 10 + 1] = 0.25;
        for block in [1usize, 64, 480] {
            let (out, latency) = limited(fs, &x, block);
            let pos = out
                .as_chunks::<2>()
                .0
                .iter()
                .position(|f| f[0] != 0.0)
                .expect("impulse");
            assert_eq!(pos - 10, latency, "fs={fs} block={block}");
            assert_eq!(
                out[2 * pos],
                0.5,
                "below the ceiling the limiter is transparent"
            );
            assert_eq!(out[2 * pos + 1], 0.25);
        }
        let ms = 1000.0 * DspChain::new(fs).latency_frames() as f64 / fs as f64;
        assert_eq!(ms, 0.0, "latency is 0 with the limiter off");
    }
    let mut chain = DspChain::new(48_000);
    chain.set_config(&DspConfig {
        limiter: true,
        ..DspConfig::default()
    });
    println!("limiter latency @48k: {} frames", chain.latency_frames());
}

#[test]
fn dsp_limiter_release_recovers() {
    let fs = 48_000u32;
    // Loud burst, then a quiet tone: gain must come back to unity (release ~100 ms).
    let x = stereo(fs as usize, |n| {
        let s = (2.0 * PI * 440.0 * n as f64 / fs as f64).sin();
        if n < 4_800 {
            (3.0 * s, 3.0 * s)
        } else {
            (0.25 * s, 0.25 * s)
        }
    });
    let (out, latency) = limited(fs, &x, 256);
    let tail = &out[2 * (fs as usize - 4_800)..];
    let peak = tail.iter().fold(0.0f64, |p, v| p.max(v.abs()));
    assert!(
        (db(peak) - db(0.25)).abs() < 0.01,
        "released gain: {:.3} dB",
        db(peak) - db(0.25)
    );
    let _ = latency;
}

//! Conformer: bit-exact pass-through, dual mono, BS.775 down-mix, exact output length, alignment of
//! the first output sample with the first input sample, and resampler quality measurements.
//!
//! Run with `--nocapture` to see the measured passband ripple and stopband attenuation.

mod decode_support;

use std::f64::consts::PI;

use decode_support::*;
use musify_audio::decode::{ChannelLayout, Conformer, MINUS_3DB, ResamplerKind};

/// Deterministic pseudo-random samples in [-1, 1).
fn noise(n: usize, seed: u64) -> Vec<f64> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
        })
        .collect()
}

/// Feeds `input` in chunks of varying size (cycling through `chunks` frames) and flushes.
fn run(conf: &mut Conformer, input: &[f64], channels: usize, chunks: &[usize]) -> Vec<f64> {
    let mut out = Vec::new();
    let mut pos = 0;
    let mut i = 0;
    while pos < input.len() {
        let n = (chunks[i % chunks.len()] * channels).min(input.len() - pos);
        conf.process(&input[pos..pos + n], &mut out);
        pos += n;
        i += 1;
    }
    conf.flush(&mut out);
    out
}

fn stereo_sine(freq: f64, rate: f64, frames: usize, amp: f64) -> Vec<f64> {
    (0..frames)
        .flat_map(|n| {
            let v = amp * (2.0 * PI * freq * n as f64 / rate).sin();
            [v, v]
        })
        .collect()
}

fn expected_len(n: u64, src: u32, dst: u32) -> u64 {
    (n * u64::from(dst) + u64::from(src) / 2) / u64::from(src)
}

#[test]
fn same_rate_stereo_is_bit_exact() {
    let input = noise(2 * 10_000, 1);
    let mut c = Conformer::new(44100, 2, 44100);
    assert_eq!(c.resampler_kind(), None);
    let out = run(&mut c, &input, 2, &[1, 37, 1024, 4096]);
    assert_eq!(out.len(), input.len());
    assert!(
        out.iter()
            .zip(&input)
            .all(|(a, b)| a.to_bits() == b.to_bits())
    );
}

#[test]
fn mono_is_duplicated_exactly() {
    let input = noise(10_000, 2);
    let mut c = Conformer::new(48000, 1, 48000);
    let out = run(&mut c, &input, 1, &[333]);
    assert_eq!(out.len(), 2 * input.len());
    for (i, s) in input.iter().enumerate() {
        assert_eq!(out[2 * i].to_bits(), s.to_bits());
        assert_eq!(out[2 * i + 1].to_bits(), s.to_bits());
    }
    // With resampling both sides stay identical.
    let mut c = Conformer::new(44100, 1, 48000);
    let out = run(&mut c, &input, 1, &[500]);
    assert!(
        out.as_chunks::<2>()
            .0
            .iter()
            .all(|[l, r]| l.to_bits() == r.to_bits())
    );
}

#[test]
fn surround_51_downmix_coefficients() {
    let mut c = Conformer::new(48000, 6, 48000);
    let s = 1.0 / (1.0 + 2.0 * MINUS_3DB);
    // Unit impulse on each channel in turn: FL FR FC LFE BL BR.
    let expect = [
        (s, 0.0),
        (0.0, s),
        (MINUS_3DB * s, MINUS_3DB * s),
        (0.0, 0.0),
        (MINUS_3DB * s, 0.0),
        (0.0, MINUS_3DB * s),
    ];
    let mut input = Vec::new();
    for ch in 0..6 {
        let mut frame = [0.0; 6];
        frame[ch] = 1.0;
        input.extend_from_slice(&frame);
    }
    let mut out = Vec::new();
    c.process(&input, &mut out);
    for (ch, (l, r)) in expect.iter().enumerate() {
        assert!(
            (out[2 * ch] - l).abs() < 1e-15 && (out[2 * ch + 1] - r).abs() < 1e-15,
            "channel {ch}: {:?}",
            &out[2 * ch..2 * ch + 2]
        );
    }
    println!(
        "5.1 → stereo: FL→L {s:.4} ({:.2} dB), FC/BL→L {:.4} ({:.2} dB), LFE dropped",
        20.0 * s.log10(),
        MINUS_3DB * s,
        20.0 * (MINUS_3DB * s).log10()
    );
    // Full scale on all channels (worst case) cannot clip.
    let mut out = Vec::new();
    c.process(&[1.0; 6], &mut out);
    c.process(&[-1.0; 6], &mut out);
    assert!(out.iter().all(|v| v.abs() <= 1.0 + 1e-15), "{out:?}");
    // Layouts from the decoder are honoured (here 7.1 with side channels).
    let m = ChannelLayout::default_for(8).downmix_matrix();
    let sum_l: f64 = m.iter().map(|g| g.0).sum();
    assert!((sum_l - 1.0).abs() < 1e-12);
}

#[test]
fn resampled_length_is_exact_for_any_chunking() {
    let pairs = [
        (44100, 48000),
        (96000, 48000),
        (48000, 44100),
        (44100, 96000),
        (88200, 48000),
        (192000, 44100),
        (22050, 48000),
    ];
    for (src, dst) in pairs {
        for n in [1usize, 7, 100, 4410, 44100, 100_003] {
            let input = noise(2 * n, n as u64);
            let mut c = Conformer::new(src, 2, dst);
            let out = run(&mut c, &input, 2, &[n.min(4096), 17, 1000]);
            assert_eq!(
                (out.len() / 2) as u64,
                expected_len(n as u64, src, dst),
                "{src}->{dst}, {n} frames"
            );
            assert!(out.iter().all(|v| v.is_finite()));
        }
        // Chunking does not change a single sample.
        let input = noise(2 * 30_000, 99);
        let a = run(&mut Conformer::new(src, 2, dst), &input, 2, &[30_000]);
        let b = run(
            &mut Conformer::new(src, 2, dst),
            &input,
            2,
            &[1, 2, 3, 500, 4095],
        );
        assert!(a == b, "{src}->{dst}: output depends on chunking");
        // Reusable after flush.
        let mut c = Conformer::new(src, 2, dst);
        let first = run(&mut c, &input, 2, &[1024]);
        let second = run(&mut c, &input, 2, &[1024]);
        assert!(first == second, "{src}->{dst}: flush resets state");
    }
}

struct Quality {
    worst_ripple_db: f64,
    worst_stop_db: f64,
    offset_samples: f64,
}

/// Measures alignment, passband ripple (to 20 kHz) and stopband rejection for one rate pair.
/// `stop` lists (input tone, frequency where its image / alias lands in the output).
fn measure(src: u32, dst: u32, stop: &[(f64, f64)]) -> Quality {
    let frames = src as usize * 2; // 2 s
    let (fs, fd) = (f64::from(src), f64::from(dst));
    let edge = dst as usize / 10; // ignore 100 ms at both ends (start/end transients of the test tone)

    // Alignment: a sine that starts at t = 0 must come out with phase 0 at output frame 0.
    let f0 = 997.0;
    let out = run(
        &mut Conformer::new(src, 2, dst),
        &stereo_sine(f0, fs, frames, 0.5),
        2,
        &[4096],
    );
    assert_eq!(
        (out.len() / 2) as u64,
        expected_len(frames as u64, src, dst)
    );
    let l = channel(&out, 0, 2);
    let seg = &l[edge..l.len() - edge];
    // Fit relative to output frame `edge`: expected phase = 2π f0 edge / fd.
    let (amp, phase) = fit_sines(seg, &[f0 / fd])[0];
    let expected_phase = (2.0 * PI * f0 * edge as f64 / fd).rem_euclid(2.0 * PI);
    let mut dphi = (phase - expected_phase).rem_euclid(2.0 * PI);
    if dphi > PI {
        dphi -= 2.0 * PI;
    }
    let offset_samples = dphi / (2.0 * PI * f0 / fd);
    let resid: Vec<f64> = seg
        .iter()
        .enumerate()
        .map(|(i, v)| v - amp * (2.0 * PI * f0 / fd * i as f64 + phase).sin())
        .collect();
    println!(
        "{src}->{dst} [{:?}]: alignment offset {offset_samples:+.2e} output samples; 997 Hz gain {:+.5} dB; residual (THD+N) {:.1} dB",
        Conformer::new(src, 2, dst).resampler_kind().unwrap(),
        20.0 * (amp / 0.5).log10(),
        20.0 * (rms(&resid) / (0.5 / 2f64.sqrt())).log10()
    );

    // Passband ripple.
    let mut worst_ripple_db: f64 = 0.0;
    let mut line = String::new();
    for f in [
        20.0, 100.0, 1000.0, 5000.0, 10000.0, 15000.0, 18000.0, 19000.0, 20000.0,
    ] {
        let out = run(
            &mut Conformer::new(src, 2, dst),
            &stereo_sine(f, fs, frames, 0.5),
            2,
            &[4096],
        );
        let l = channel(&out, 0, 2);
        let (a, _) = fit_sines(&l[edge..l.len() - edge], &[f / fd])[0];
        let db = 20.0 * (a / 0.5).log10();
        worst_ripple_db = worst_ripple_db.max(db.abs());
        line += &format!(" {:.0}Hz {db:+.5}", f);
    }
    println!("{src}->{dst}: passband (dB):{line}");

    // Stopband: the image / alias of an out-of-band tone, relative to the tone.
    let mut worst_stop_db = f64::MIN;
    let mut line = String::new();
    for &(tone, lands_at) in stop {
        let out = run(
            &mut Conformer::new(src, 2, dst),
            &stereo_sine(tone, fs, frames, 0.5),
            2,
            &[4096],
        );
        let l = channel(&out, 0, 2);
        let mut freqs = vec![lands_at / fd];
        if tone < fd / 2.0 {
            freqs.push(tone / fd); // the tone itself is (partly) in band: fit it jointly
        }
        let fit = fit_sines(&l[edge..l.len() - edge], &freqs);
        let db = 20.0 * (fit[0].0 / 0.5).max(1e-20).log10();
        worst_stop_db = worst_stop_db.max(db);
        line += &format!(" {tone:.0}Hz→{lands_at:.0}Hz {db:.1}");
    }
    println!("{src}->{dst}: stopband (dB re tone):{line}");
    Quality {
        worst_ripple_db,
        worst_stop_db,
        offset_samples,
    }
}

#[test]
fn quality_44k1_to_48k() {
    // Upsampling: a tone at f leaves an image at 44100 − f, which lands in the 48 kHz band
    // (< 24 kHz) for f > 20.1 kHz.
    let q = measure(
        44100,
        48000,
        &[(20500.0, 23600.0), (21000.0, 23100.0), (21500.0, 22600.0)],
    );
    assert!(
        q.offset_samples.abs() < 1e-3,
        "alignment {}",
        q.offset_samples
    );
    assert!(
        q.worst_ripple_db <= 0.01,
        "passband ripple {} dB",
        q.worst_ripple_db
    );
    assert!(
        q.worst_stop_db <= -120.0,
        "images at {} dB",
        q.worst_stop_db
    );
    assert!(matches!(
        Conformer::new(44100, 2, 48000).resampler_kind(),
        Some(ResamplerKind::Fft { .. })
    ));
}

#[test]
fn quality_96k_to_48k() {
    // Downsampling: a tone at f > 24 kHz aliases to 48000 − f.
    let q = measure(
        96000,
        48000,
        &[
            (24500.0, 23500.0),
            (25000.0, 23000.0),
            (30000.0, 18000.0),
            (40000.0, 8000.0),
        ],
    );
    assert!(
        q.offset_samples.abs() < 1e-3,
        "alignment {}",
        q.offset_samples
    );
    assert!(
        q.worst_ripple_db <= 0.01,
        "passband ripple {} dB",
        q.worst_ripple_db
    );
    assert!(
        q.worst_stop_db <= -120.0,
        "aliases at {} dB",
        q.worst_stop_db
    );
}

#[test]
fn quality_48k_to_44k1() {
    let q = measure(48000, 44100, &[(22500.0, 21600.0), (23000.0, 21100.0)]);
    assert!(
        q.offset_samples.abs() < 1e-3,
        "alignment {}",
        q.offset_samples
    );
    assert!(
        q.worst_ripple_db <= 0.01,
        "passband ripple {} dB",
        q.worst_ripple_db
    );
    assert!(
        q.worst_stop_db <= -120.0,
        "aliases at {} dB",
        q.worst_stop_db
    );
}

/// No leading silence: a DC level that starts at input frame 0 is already there at output frame 0
/// (a resampler without delay compensation would output ~1000 frames of near-silence first).
#[test]
fn first_output_sample_aligns_with_first_input_sample() {
    for (src, dst) in [(44100, 48000), (96000, 48000), (48000, 44100)] {
        let n = src as usize / 2;
        let input: Vec<f64> = vec![0.5; 2 * n];
        let out = run(&mut Conformer::new(src, 2, dst), &input, 2, &[4096]);
        // Output frame 0 sits exactly on the step (input frame 0), so it carries roughly the input
        // level, give or take the band-limited step's ringing.
        println!(
            "{src}->{dst}: first output samples {:?}",
            &channel(&out, 0, 2)[..4]
        );
        assert!(
            (out[0] - 0.5).abs() < 0.2,
            "{src}->{dst}: first sample {}",
            out[0]
        );
        let mid = out.len() / 2;
        assert!(
            (out[mid] - 0.5).abs() < 1e-9,
            "{src}->{dst}: DC gain {}",
            out[mid]
        );
    }
}

/// Source rate, device rate, (out-of-band tone, where its alias or image lands).
type RatePair = (u32, u32, &'static [(f64, f64)]);

/// Hi-res sources on a 48 kHz (or 44.1 kHz) device, and CD material on a 192 kHz device: the same
/// passband and stopband limits as the CD-rate pairs.
#[test]
fn quality_hi_res_rate_pairs() {
    let cases: [RatePair; 4] = [
        // 192 kHz → 48 kHz: tones above 24 kHz alias to 48000 − f (or fold twice).
        (
            192_000,
            48_000,
            &[
                (25_000.0, 23_000.0),
                (30_000.0, 18_000.0),
                (60_000.0, 12_000.0),
            ],
        ),
        // 352.8 kHz → 44.1 kHz (8:1).
        (
            352_800,
            44_100,
            &[
                (23_000.0, 21_100.0),
                (30_000.0, 14_100.0),
                (100_000.0, 11_800.0),
            ],
        ),
        // 176.4 kHz → 96 kHz: content above 48 kHz aliases to 96000 − f.
        (
            176_400,
            96_000,
            &[(50_000.0, 46_000.0), (70_000.0, 26_000.0)],
        ),
        // 44.1 kHz → 192 kHz: a tone at f leaves an image at 44100 − f.
        (
            44_100,
            192_000,
            &[(20_500.0, 23_600.0), (21_500.0, 22_600.0)],
        ),
    ];
    for (src, dst, stop) in cases {
        let q = measure(src, dst, stop);
        assert!(
            q.offset_samples.abs() < 1e-3,
            "{src}->{dst} alignment {}",
            q.offset_samples
        );
        assert!(
            q.worst_ripple_db <= 0.01,
            "{src}->{dst} passband ripple {} dB",
            q.worst_ripple_db
        );
        assert!(
            q.worst_stop_db <= -120.0,
            "{src}->{dst} aliases/images at {} dB",
            q.worst_stop_db
        );
    }
}

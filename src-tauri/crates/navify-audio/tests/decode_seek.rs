//! Seeking to t and decoding must reproduce the corresponding samples of a full decode: bit-exact
//! for lossless formats, and for lossy formats within the noise of the codec's pre-roll.

mod decode_support;

use decode_support::*;

/// Decodes `frames` frames after seeking `name` to `ms`; returns (returned ms, start frame, samples).
fn decode_after_seek(name: &str, ms: u64, frames: usize) -> (u64, u64, Vec<f64>) {
    let mut d = open(name);
    let got = d.seek(ms).expect("seek");
    let start = d.position_frames();
    let ch = d.channels();
    let mut out = Vec::new();
    while out.len() < frames * ch {
        if d.next_frames(&mut out).unwrap() == 0 {
            break;
        }
    }
    out.truncate(frames * ch);
    (got, start, out)
}

fn max_abs_diff(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max)
}

fn check(name: &str, tolerance: f64) {
    let mut full_dec = open(name);
    let rate = u64::from(full_dec.sample_rate());
    let ch = full_dec.channels();
    let total = full_dec.info().n_frames.unwrap();
    let full = decode_all(&mut full_dec);
    let total_ms = total * 1000 / rate;
    let mut worst: f64 = 0.0;
    for ms in [
        0,
        1,
        123,
        333,
        499,
        total_ms / 2 + 7,
        total_ms.saturating_sub(40),
    ] {
        let frames = 2048;
        let (got, start, out) = decode_after_seek(name, ms, frames);
        let expect_start = ms * rate / 1000;
        assert_eq!(
            got,
            expect_start * 1000 / rate,
            "{name} @ {ms} ms: returned position"
        );
        assert_eq!(start, expect_start, "{name} @ {ms} ms: frame position");
        let avail = (total - expect_start).min(frames as u64) as usize;
        assert_eq!(out.len(), avail * ch, "{name} @ {ms} ms: frames after seek");
        let reference = &full[expect_start as usize * ch..(expect_start as usize + avail) * ch];
        let diff = max_abs_diff(&out, reference);
        worst = worst.max(diff);
        if tolerance == 0.0 {
            assert!(
                out == reference,
                "{name} @ {ms} ms: not bit-exact (max diff {diff:e})"
            );
        } else {
            assert!(
                diff <= tolerance,
                "{name} @ {ms} ms: max diff {diff:e} > {tolerance:e}"
            );
        }
    }
    println!("{name}: seek vs full decode, worst max abs diff {worst:e}");

    // Repeated seeks on one decoder: backwards, forwards, to the end and past it.
    let mut d = open(name);
    for ms in [400, 100, 900, 0, total_ms, total_ms + 5000, 250] {
        let got = d.seek(ms).unwrap();
        let start = ms.min(total_ms) * rate / 1000;
        assert_eq!(
            d.position_frames(),
            start.min(total),
            "{name}: position after seek to {ms}"
        );
        assert_eq!(got, start.min(total) * 1000 / rate);
        let mut out = Vec::new();
        let n = d.next_frames(&mut out).unwrap();
        if start >= total {
            assert_eq!(n, 0, "{name}: seek to the end yields EOF");
        } else {
            let reference = &full[start as usize * ch..(start as usize + n) * ch];
            assert!(
                max_abs_diff(&out, reference) <= tolerance,
                "{name}: repeated seek to {ms}"
            );
        }
    }
}

#[test]
fn flac_seek_is_bit_exact() {
    check("gapless_full.flac", 0.0);
    check("flac24_96k.flac", 0.0);
    check("surround51.flac", 0.0);
    check("mono.flac", 0.0);
}

#[test]
fn wav_seek_is_bit_exact() {
    check("wav24_48k.wav", 0.0);
    check("gapless_src.wav", 0.0);
}

#[test]
fn alac_seek_is_bit_exact() {
    check("gapless_full.alac.m4a", 0.0);
}

#[test]
fn mp3_seek_is_sample_accurate() {
    // Two frames of pre-roll rebuild the bit reservoir and overlap: bit-exact.
    check("gapless_full.mp3", 0.0);
}

#[test]
fn aac_seek_is_sample_accurate() {
    // Exact except for perceptual-noise-substitution bands: their noise comes from the decoder's
    // random generator, whose state depends on everything decoded before (peak ≈ −45 dBFS here).
    check("gapless_full.aac.m4a", 1e-2);
}

#[test]
fn vorbis_seek_is_sample_accurate() {
    check("gapless_full.ogg", 0.0);
}

#[test]
#[cfg(feature = "opus")]
fn opus_seek_is_sample_accurate() {
    // The libopus state (predictors, energies) converges exponentially during the 400 ms pre-roll.
    check("gapless_full.opus", 2e-5);
}

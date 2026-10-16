//! Gapless: a continuous signal split at a non-frame-aligned sample (44.1 kHz: 29399 of 66150,
//! 48 kHz Opus: 31999 of 72000) and encoded per part must concatenate back seamlessly.

mod decode_support;

use decode_support::*;

const SPLIT_44: usize = 29399;
const TOTAL_44: usize = 66150;
const SPLIT_48: usize = 31999;
const TOTAL_48: usize = 72000;

fn concat_parts(ext: &str) -> (Vec<f64>, usize, usize) {
    let mut p1 = open(&format!("gapless_p1.{ext}"));
    let mut p2 = open(&format!("gapless_p2.{ext}"));
    let a = decode_all(&mut p1);
    let b = decode_all(&mut p2);
    let ch = p1.channels();
    assert_eq!(p2.channels(), ch);
    let (n1, n2) = (a.len() / ch, b.len() / ch);
    assert_eq!(p1.info().n_frames, Some(n1 as u64), "{ext}: p1 n_frames matches decoded length");
    assert_eq!(p2.info().n_frames, Some(n2 as u64), "{ext}: p2 n_frames matches decoded length");
    let mut all = a;
    all.extend_from_slice(&b);
    (all, n1, n2)
}

#[test]
fn lossless_parts_are_bit_identical_to_source() {
    let (src, rate, ch) = read_wav16("gapless_src.wav");
    assert_eq!((rate, ch), (44100, 2));
    assert_eq!(src.len() / 2, TOTAL_44);

    // WAV itself.
    let mut wav = open("gapless_src.wav");
    assert!(decode_all(&mut wav) == src, "WAV decodes bit-exactly");

    for ext in ["flac", "alac.m4a"] {
        let (all, n1, n2) = concat_parts(ext);
        assert_eq!((n1, n2), (SPLIT_44, TOTAL_44 - SPLIT_44), "{ext}: part lengths");
        let first_diff = all.iter().zip(&src).position(|(a, b)| a.to_bits() != b.to_bits());
        assert_eq!(first_diff, None, "{ext}: concatenated parts differ from the source");
        assert_eq!(all.len(), src.len());

        let mut full = open(&format!("gapless_full.{ext}"));
        assert!(decode_all(&mut full) == src, "{ext}: full file bit-exact");
        println!("{ext}: parts {n1} + {n2} frames, bit-identical to source");
    }
}

/// The generator formula of the fixtures (`generate.ps1`), quantized like ffmpeg's s16 output.
fn synth_source(rate: f64, frames: usize) -> Vec<f64> {
    use std::f64::consts::PI;
    let q = |v: f64| (v * 32768.0).round().clamp(-32768.0, 32767.0) / 32768.0;
    let mut out = Vec::with_capacity(frames * 2);
    for n in 0..frames {
        let t = n as f64 / rate;
        out.push(q(0.3 * (2.0 * PI * 440.0 * t).sin() + 0.2 * (2.0 * PI * (200.0 + 1500.0 * t) * t).sin()));
        out.push(q(0.3 * (2.0 * PI * 660.0 * t).sin() + 0.15 * (2.0 * PI * 1234.0 * t).sin()));
    }
    out
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-12).log10()
}

/// Lossy codecs: exact part lengths, both parts time-aligned with the source (lag 0), and no
/// click at the joint: the error against the source around the joint stays within `max_excess_db`
/// of the codec's typical error inside the parts.
fn check_lossy(ext: &str, split: usize, total: usize, max_excess_db: f64) {
    let (all, n1, n2) = concat_parts(ext);
    let ch = 2;
    println!("{ext}: parts {n1} + {n2} = {} frames (source {split} + {})", n1 + n2, total - split);
    assert_eq!(n1, split, "{ext}: part 1 length");
    assert_eq!(n2, total - split, "{ext}: part 2 length");

    let src = if split == SPLIT_44 { read_wav16("gapless_src.wav").0 } else { synth_source(48000.0, total) };
    assert_eq!(src.len(), all.len());

    // Time alignment of the end of part 1 and the start of part 2 against the source.
    let (l_all, l_src) = (channel(&all, 0, ch), channel(&src, 0, ch));
    let lag = |from: usize| {
        let a = &l_all[from..from + 4096];
        (-40..=40isize)
            .max_by(|&x, &y| {
                let c = |lg: isize| a.iter().enumerate().map(|(i, v)| v * l_src[(from as isize + i as isize + lg) as usize]).sum::<f64>();
                c(x).total_cmp(&c(y))
            })
            .unwrap()
    };
    let (lag1, lag2) = (lag(split - 4096 - 512), lag(split + 512));
    println!("{ext}: lag vs source: part 1 tail {lag1}, part 2 head {lag2}");
    assert_eq!((lag1, lag2), (0, 0), "{ext}: parts are time-aligned with the source");

    // Error against the source in 256-frame windows.
    let err: Vec<f64> = all.iter().zip(&src).map(|(a, b)| a - b).collect();
    let w = 256;
    let win_db = |start: usize| db(rms(&err[start * ch..(start + w) * ch]));
    let joint = (split - 2 * w..split + 4 * w).step_by(w).map(win_db).fold(f64::MIN, f64::max);
    let mut interior: Vec<f64> = (2048..total - 2048 - w)
        .step_by(w)
        .filter(|&s| s + w + 2048 < split || s > split + 2048)
        .map(win_db)
        .collect();
    interior.sort_by(f64::total_cmp);
    let median = interior[interior.len() / 2];
    let worst = *interior.last().unwrap();
    let signal_db = db(rms(&src));
    println!(
        "{ext}: error vs source (dB re full scale): joint max {joint:.1}, parts median {median:.1}, parts worst {worst:.1}, signal {signal_db:.1}"
    );
    assert!(
        joint - median <= max_excess_db,
        "{ext}: error at the joint exceeds codec noise by {:.1} dB",
        joint - median
    );
}

#[test]
fn mp3_parts_join_seamlessly() {
    check_lossy("mp3", SPLIT_44, TOTAL_44, 6.0);
}

#[test]
fn aac_parts_join_seamlessly() {
    // ffmpeg's native AAC encoder produces a short burst of error in the first ~700 samples of a
    // stream (ffmpeg's own decoder reproduces it bit-for-bit), so the joint shows up to ~30 dB more
    // error than the interior. Lengths and alignment are exact.
    check_lossy("aac.m4a", SPLIT_44, TOTAL_44, 32.0);
}

#[test]
fn vorbis_parts_join_seamlessly() {
    // Each part is encoded with a hard cut at the split; the transform codecs smear a little
    // quantization noise across the cut (≈ 13 dB above the interior median, ≈ 4 dB above the worst
    // interior window). A gap or overlap of even one sample would fail the lag check instead.
    check_lossy("ogg", SPLIT_44, TOTAL_44, 15.0);
}

#[test]
#[cfg(feature = "opus")]
fn opus_parts_join_seamlessly() {
    check_lossy("opus", SPLIT_48, TOTAL_48, 15.0);
}

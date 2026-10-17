//! Throughput of Decoder + Conformer. Meaningful in release builds:
//! `cargo test --release -p musify-audio --test decode_perf -- --nocapture`

mod decode_support;

use std::time::Instant;

use decode_support::*;
use musify_audio::decode::Conformer;

fn speed(name: &str, dst: u32, rounds: usize) -> f64 {
    let mut audio_secs = 0.0;
    let t = Instant::now();
    for _ in 0..rounds {
        let mut d = open(name);
        let mut c = Conformer::with_layout(d.sample_rate(), d.channel_layout(), dst);
        let mut native = Vec::new();
        let mut out = Vec::new();
        loop {
            native.clear();
            let n = d.next_frames(&mut native).unwrap();
            if n == 0 {
                c.flush(&mut out);
                break;
            }
            c.process(&native, &mut out);
            out.clear();
        }
        audio_secs += d.info().n_frames.unwrap() as f64 / f64::from(d.sample_rate());
    }
    let x = audio_secs / t.elapsed().as_secs_f64();
    println!("{name} -> {dst} Hz: {x:.0}x real time");
    x
}

#[test]
fn decode_and_resample_faster_than_real_time() {
    let rounds = if cfg!(debug_assertions) { 2 } else { 40 };
    let x = speed("flac24_96k.flac", 48000, rounds);
    speed("gapless_full.flac", 48000, rounds);
    speed("gapless_full.mp3", 48000, rounds);
    speed("gapless_full.aac.m4a", 48000, rounds);
    if cfg!(feature = "opus") {
        speed("gapless_full.opus", 44100, rounds);
    }
    if !cfg!(debug_assertions) {
        assert!(x > 50.0, "24/96 FLAC → 48 kHz only {x:.0}x real time");
    }
}

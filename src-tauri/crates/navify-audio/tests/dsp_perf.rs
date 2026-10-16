//! Performance: `cargo test -p navify-audio --release --test dsp_perf -- --ignored --nocapture`

use std::time::Instant;

use navify_audio::api::{
    BassEnhancerConfig, DspConfig, EqConfig, EqMode, GraphicBands, StereoConfig,
};
use navify_audio::dsp::DspChain;

fn measure(name: &str, fs: u32, config: &DspConfig, gliding: bool) -> f64 {
    let mut chain = DspChain::new(fs);
    chain.set_config(config);
    chain.set_volume(0.5);
    chain.reset();
    let block = 512;
    let mut buf: Vec<f64> = (0..2 * block)
        .map(|i| 0.8 * (i as f64 * 0.0123).sin())
        .collect();
    let seconds = 20.0;
    let blocks = (seconds * fs as f64 / block as f64) as usize;
    let mut cfg = config.clone();
    let start = Instant::now();
    for k in 0..blocks {
        if gliding && k % 50 == 0 {
            // Keep every EQ band gliding.
            if let EqMode::Graphic { gains_db, .. } = &mut cfg.eq.mode {
                gains_db.iter_mut().for_each(|g| *g = -*g + 0.5);
            }
            chain.set_config(&cfg);
        }
        chain.process(&mut buf);
    }
    let elapsed = start.elapsed().as_secs_f64();
    let ns_per_frame = elapsed * 1e9 / (blocks * block) as f64;
    let rt = 100.0 * elapsed / seconds;
    println!(
        "{name:<44} @ {fs:>6}: {ns_per_frame:7.1} ns/frame = {rt:.3} % of real time (one stereo stream)"
    );
    std::hint::black_box(&buf);
    ns_per_frame
}

#[test]
#[ignore]
fn dsp_perf_31_band_bass_limiter() {
    let gains: Vec<f64> = (0..31).map(|i| ((i * 7) % 13) as f64 - 6.0).collect();
    let full = DspConfig {
        eq: EqConfig {
            enabled: true,
            preamp_db: 0.0,
            auto_headroom: true,
            mode: EqMode::Graphic {
                bands: GraphicBands::ThirtyOne,
                gains_db: gains,
            },
        },
        bass: BassEnhancerConfig {
            enabled: true,
            boost_db: 6.0,
            frequency_hz: 80.0,
            harmonics: 0.3,
        },
        stereo: StereoConfig::default(),
        loudness_compensation: false,
        limiter: true,
    };
    let ns = measure("31-band EQ + bass + limiter", 48_000, &full, false);
    measure("31-band EQ + bass + limiter (gliding)", 48_000, &full, true);
    let all = DspConfig {
        loudness_compensation: true,
        stereo: StereoConfig {
            width: 1.3,
            mono: false,
            balance: 0.1,
        },
        ..full.clone()
    };
    measure("everything on", 48_000, &all, false);
    measure("everything on", 192_000, &all, false);
    measure(
        "limiter only",
        48_000,
        &DspConfig {
            limiter: true,
            ..DspConfig::default()
        },
        false,
    );
    measure("bypass (volume 0.5)", 48_000, &DspConfig::default(), false);
    // 1 % of real time at 48 kHz is 208 ns per frame.
    assert!(ns < 208.0, "{ns:.1} ns/frame");
}

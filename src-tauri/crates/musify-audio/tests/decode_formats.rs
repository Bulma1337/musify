//! Every fixture format decodes with correct `DecodedInfo`, exact integer conversion and the right
//! channel order; ReplayGain / R128 tags are read.

mod decode_support;

use decode_support::*;
use musify_audio::decode::Speaker;

struct Expect {
    name: &'static str,
    codec: &'static str,
    rate: u32,
    bits: Option<u32>,
    channels: u16,
    lossless: bool,
    frames: u64,
}

const fn e(
    name: &'static str,
    codec: &'static str,
    rate: u32,
    bits: Option<u32>,
    channels: u16,
    lossless: bool,
    frames: u64,
) -> Expect {
    Expect {
        name,
        codec,
        rate,
        bits,
        channels,
        lossless,
        frames,
    }
}

#[test]
fn info_fields_and_lengths() {
    let mut cases = vec![
        e("gapless_full.flac", "FLAC", 44100, Some(16), 2, true, 66150),
        e("flac24_96k.flac", "FLAC", 96000, Some(24), 2, true, 48000),
        e("wav24_48k.wav", "PCM", 48000, Some(24), 2, true, 24000),
        e("gapless_src.wav", "PCM", 44100, Some(16), 2, true, 66150),
        e(
            "gapless_full.alac.m4a",
            "ALAC",
            44100,
            Some(16),
            2,
            true,
            66150,
        ),
        e("gapless_full.mp3", "MP3", 44100, None, 2, false, 66150),
        e("gapless_full.aac.m4a", "AAC", 44100, None, 2, false, 66150),
        e("gapless_full.ogg", "Vorbis", 44100, None, 2, false, 66150),
        e("mono.flac", "FLAC", 44100, Some(24), 1, true, 22050),
        e("surround51.flac", "FLAC", 48000, Some(24), 6, true, 24000),
    ];
    if cfg!(feature = "opus") {
        cases.push(e("gapless_full.opus", "Opus", 48000, None, 2, false, 72000));
    }
    for c in cases {
        let mut d = open(c.name);
        let info = d.info().clone();
        let f = &info.format;
        println!("{}: {:?}", c.name, info);
        assert_eq!(f.codec, c.codec, "{}", c.name);
        assert_eq!(f.sample_rate, c.rate, "{}", c.name);
        assert_eq!(f.bits_per_sample, c.bits, "{}", c.name);
        assert_eq!(f.channels, c.channels, "{}", c.name);
        assert_eq!(f.lossless, c.lossless, "{}", c.name);
        assert!(
            f.bitrate_kbps.is_some_and(|k| k > 16),
            "{}: bitrate",
            c.name
        );
        assert_eq!(info.n_frames, Some(c.frames), "{}", c.name);
        assert_eq!(
            info.duration_ms,
            Some(c.frames * 1000 / u64::from(c.rate)),
            "{}",
            c.name
        );
        assert_eq!(d.sample_rate(), c.rate);
        assert_eq!(d.channels(), usize::from(c.channels));
        let samples = decode_all(&mut d);
        assert_eq!(
            samples.len() as u64,
            c.frames * u64::from(c.channels),
            "{}: decoded length",
            c.name
        );
        assert!(
            samples.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
            "{}: range",
            c.name
        );
    }
}

#[test]
fn lossy_bitrates_are_plausible() {
    let mut names = vec![
        "gapless_full.mp3",
        "gapless_full.aac.m4a",
        "gapless_full.ogg",
    ];
    if cfg!(feature = "opus") {
        names.push("gapless_full.opus");
    }
    for name in names {
        let kbps = open(name).info().format.bitrate_kbps.unwrap();
        println!("{name}: {kbps} kbps");
        assert!((40..400).contains(&kbps), "{name}: {kbps} kbps");
    }
}

/// Integer PCM converts exactly: every sample is k / 2^(bits-1).
#[test]
fn integer_pcm_is_exact() {
    for (name, bits) in [
        ("flac24_96k.flac", 24),
        ("wav24_48k.wav", 24),
        ("gapless_full.flac", 16),
        ("gapless_full.alac.m4a", 16),
    ] {
        let mut d = open(name);
        let s = decode_all(&mut d);
        let scale = f64::from(1u32 << (bits - 1));
        let mut distinct_lsb = false;
        for v in &s {
            let k = v * scale;
            assert_eq!(
                k,
                k.round(),
                "{name}: {v} is not a multiple of 2^-{}",
                bits - 1
            );
            assert!((-scale..scale).contains(&k));
            distinct_lsb |= (k as i64) & 1 == 1;
        }
        assert!(distinct_lsb, "{name}: full {bits}-bit resolution is used");
    }
    // 24-bit WAV: R = âˆ’L exactly (ffmpeg rounds symmetrically).
    let mut d = open("wav24_48k.wav");
    let s = decode_all(&mut d);
    let fit = fit_sines(&channel(&s, 0, 2), &[1000.0 / 48000.0]);
    assert!((fit[0].0 - 0.5).abs() < 1e-6, "amplitude {}", fit[0].0);
}

#[test]
fn mono_and_surround_layouts() {
    let mono = open("mono.flac");
    assert_eq!(mono.channel_layout().channels(), 1);

    let mut d = open("surround51.flac");
    assert_eq!(
        d.channel_layout().speakers(),
        &[
            Speaker::FrontLeft,
            Speaker::FrontRight,
            Speaker::FrontCenter,
            Speaker::Lfe,
            Speaker::BackLeft,
            Speaker::BackRight
        ]
    );
    let s = decode_all(&mut d);
    // Each channel carries its own tone (generate.ps1): the order must match the layout.
    let tones = [300.0, 500.0, 700.0, 60.0, 1100.0, 1300.0];
    for (ch, f) in tones.iter().enumerate() {
        let x = channel(&s, ch, 6);
        let amp = fit_sines(&x, &[f / 48000.0])[0].0;
        assert!(
            (amp - 0.5).abs() < 1e-3,
            "channel {ch} should carry {f} Hz (amplitude {amp})"
        );
    }
}

#[test]
fn replaygain_and_r128_tags() {
    for name in ["gapless_full.flac", "gapless_full.mp3"] {
        let rg = open(name)
            .info()
            .tag_gain
            .unwrap_or_else(|| panic!("{name}: tags"));
        assert_eq!(rg.track_gain_db, Some(-6.5), "{name}");
        assert_eq!(rg.album_gain_db, Some(-7.25), "{name}");
        assert_eq!(rg.track_peak, Some(0.501), "{name}");
        assert_eq!(rg.album_peak, Some(0.602), "{name}");
    }
    assert_eq!(open("flac24_96k.flac").info().tag_gain, None);
    if cfg!(feature = "opus") {
        // R128_TRACK_GAIN = -2560 (âˆ’10 dB re âˆ’23 LUFS) â†’ âˆ’5 dB ReplayGain; album 256 â†’ +6 dB.
        let rg = open("gapless_full.opus").info().tag_gain.unwrap();
        assert_eq!(rg.track_gain_db, Some(-5.0));
        assert_eq!(rg.album_gain_db, Some(6.0));
    }
}

#[test]
fn hint_is_optional() {
    for name in [
        "gapless_full.flac",
        "gapless_full.mp3",
        "gapless_full.aac.m4a",
        "gapless_full.ogg",
    ] {
        let src = FileSource::open(&fixture(name)).unwrap();
        let mut d = musify_audio::decode::Decoder::open(Box::new(src), None).unwrap();
        assert_eq!(decode_all(&mut d).len(), 66150 * 2, "{name}");
    }
}

#[test]
fn non_seekable_sources_decode_completely() {
    for name in ["gapless_full.flac", "gapless_full.mp3", "gapless_full.ogg"] {
        let src = FileSource::open_unseekable(&fixture(name)).unwrap();
        let mut d =
            musify_audio::decode::Decoder::open(Box::new(src), hint_for(name).as_deref()).unwrap();
        let n = decode_all(&mut d).len() / 2;
        assert_eq!(n, 66150, "{name}");
    }
}

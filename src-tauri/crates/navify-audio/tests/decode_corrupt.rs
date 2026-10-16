//! Broken input yields errors or an early end of stream, never a panic.

mod decode_support;

use std::io::{Cursor, Read, Seek, SeekFrom};

use decode_support::*;
use navify_audio::decode::{DecodeError, Decoder};
use navify_audio::source::ByteSource;

struct MemSource(Cursor<Vec<u8>>);

impl Read for MemSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

impl Seek for MemSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(pos)
    }
}

impl ByteSource for MemSource {
    fn byte_len(&self) -> Option<u64> {
        Some(self.0.get_ref().len() as u64)
    }

    fn is_seekable(&self) -> bool {
        true
    }
}

fn open_bytes(bytes: Vec<u8>, hint: Option<&str>) -> Result<Decoder, DecodeError> {
    Decoder::open(Box::new(MemSource(Cursor::new(bytes))), hint)
}

/// Decodes until EOF or error; returns (frames, error).
fn drain(d: &mut Decoder) -> (usize, Option<DecodeError>) {
    let mut out = Vec::new();
    loop {
        match d.next_frames(&mut out) {
            Ok(0) => return (out.len() / d.channels().max(1), None),
            Ok(_) => assert!(out.iter().all(|s| s.is_finite())),
            Err(e) => return (out.len() / d.channels().max(1), Some(e)),
        }
    }
}

#[test]
fn truncated_flac_ends_early_with_valid_prefix() {
    let mut full = open("gapless_full.flac");
    let reference = decode_all(&mut full);
    let mut d = open("truncated.flac");
    let (frames, err) = drain(&mut d);
    println!("truncated.flac: {frames} of 66150 frames, error {err:?}");
    assert!(err.is_none(), "a truncated file ends early instead of failing: {err:?}");
    assert!(frames > 20_000 && frames < 66_150);
    let mut d = open("truncated.flac");
    let got = decode_all(&mut d);
    assert!(got[..] == reference[..got.len()], "decoded prefix is bit-exact");
}

#[test]
fn corrupt_mp3_recovers() {
    let mut d = open("corrupt.mp3");
    let (frames, err) = drain(&mut d);
    println!("corrupt.mp3: {frames} frames (clean file 66150), error {err:?}");
    assert!(err.is_none());
    // The damaged frames are skipped or concealed with silence; the rest decodes.
    assert!(frames > 55_000 && frames <= 70_000, "{frames}");
}

#[test]
fn garbage_and_empty_input_fail_cleanly() {
    let src = FileSource::open(&fixture("garbage.mp3")).unwrap();
    let r = Decoder::open(Box::new(src), Some("mp3"));
    println!("garbage.mp3: {:?}", r.as_ref().err());
    assert!(r.is_err());
    for hint in [None, Some("flac"), Some("mp3"), Some("m4a"), Some("ogg"), Some("wav")] {
        assert!(open_bytes(Vec::new(), hint).is_err(), "empty input with hint {hint:?}");
        assert!(open_bytes(b"RIFF\x10\x00\x00\x00WAVEfmt ".to_vec(), hint).is_err());
        assert!(open_bytes(b"fLaC\x00\x00\x00\x22".to_vec(), hint).is_err());
        assert!(open_bytes(b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00".to_vec(), hint).is_err());
    }
}

/// Deterministic mutation fuzzing of every fixture format: random byte flips and truncations.
#[test]
fn mutated_files_never_panic() {
    let mut names = vec!["gapless_p1.flac", "gapless_p1.mp3", "gapless_p1.aac.m4a", "gapless_p1.alac.m4a", "gapless_p1.ogg", "wav24_48k.wav"];
    if cfg!(feature = "opus") {
        names.push("gapless_p1.opus");
    }
    let mut rng: u64 = 0x5eed;
    let mut next = move |n: usize| {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (rng >> 33) as usize % n.max(1)
    };
    let (mut opened, mut errors) = (0, 0);
    for name in names {
        let clean = std::fs::read(fixture(name)).unwrap();
        for round in 0..24 {
            let mut bytes = clean.clone();
            match round % 3 {
                0 => {
                    for _ in 0..1 + next(40) {
                        let i = next(bytes.len());
                        bytes[i] = next(256) as u8;
                    }
                }
                1 => {
                    let start = next(bytes.len());
                    let len = next(2000).min(bytes.len() - start);
                    bytes[start..start + len].fill(next(256) as u8);
                }
                _ => bytes.truncate(next(bytes.len())),
            }
            match open_bytes(bytes, hint_for(name).as_deref()) {
                Ok(mut d) => {
                    opened += 1;
                    let _ = d.seek(100);
                    let (_, err) = drain(&mut d);
                    errors += usize::from(err.is_some());
                }
                Err(_) => errors += 1,
            }
        }
    }
    println!("mutated inputs: {opened} opened, {errors} ended in an error");
}

#[test]
fn forward_seek_on_unseekable_source() {
    let mut full = open("gapless_full.flac");
    let reference = decode_all(&mut full);
    let src = FileSource::open_unseekable(&fixture("gapless_full.flac")).unwrap();
    let mut d = Decoder::open(Box::new(src), Some("flac")).unwrap();
    d.seek(500).unwrap();
    assert_eq!(d.position_frames(), 22050);
    let got = decode_all(&mut d);
    assert!(got[..] == reference[22050 * 2..], "discard-forward seek is sample-exact");
}

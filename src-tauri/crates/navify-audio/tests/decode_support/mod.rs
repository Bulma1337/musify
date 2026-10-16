//! Shared helpers for the `decode_*` integration tests.
#![allow(dead_code)]

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;

use navify_audio::decode::Decoder;
use navify_audio::source::ByteSource;

/// Minimal local-file `ByteSource`.
pub struct FileSource {
    file: File,
    len: u64,
    seekable: bool,
}

impl FileSource {
    pub fn open(path: &std::path::Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self { file, len, seekable: true })
    }

    /// A source that reports itself as non-seekable (like an HTTP transcode).
    pub fn open_unseekable(path: &std::path::Path) -> io::Result<Self> {
        let mut s = Self::open(path)?;
        s.seekable = false;
        Ok(s)
    }
}

impl Read for FileSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for FileSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.file.seek(pos)
    }
}

impl ByteSource for FileSource {
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }

    fn is_seekable(&self) -> bool {
        self.seekable
    }
}

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decode").join(name)
}

pub fn hint_for(name: &str) -> Option<String> {
    name.rsplit('.').next().map(str::to_owned)
}

pub fn open(name: &str) -> Decoder {
    let src = FileSource::open(&fixture(name)).expect("fixture exists");
    Decoder::open(Box::new(src), hint_for(name).as_deref()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

pub fn decode_all(dec: &mut Decoder) -> Vec<f64> {
    let mut out = Vec::new();
    loop {
        let n = dec.next_frames(&mut out).expect("decode");
        if n == 0 {
            return out;
        }
    }
}

/// Independent reader for the 16-bit PCM WAV reference (exact `x / 32768`).
pub fn read_wav16(name: &str) -> (Vec<f64>, u32, usize) {
    let data = std::fs::read(fixture(name)).unwrap();
    assert_eq!(&data[0..4], b"RIFF");
    let mut pos = 12;
    let mut rate = 0;
    let mut channels = 0;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &data[pos + 8..pos + 8 + size];
        if id == b"fmt " {
            channels = u16::from_le_bytes([body[2], body[3]]) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16);
        } else if id == b"data" {
            let samples = body.as_chunks::<2>().0.iter().map(|b| f64::from(i16::from_le_bytes(*b)) / 32768.0).collect();
            return (samples, rate, channels);
        }
        pos += 8 + size + (size & 1);
    }
    panic!("no data chunk");
}

/// Root-mean-square of a slice.
pub fn rms(x: &[f64]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt()
}

/// One channel of an interleaved buffer.
pub fn channel(x: &[f64], ch: usize, n_ch: usize) -> Vec<f64> {
    x.iter().skip(ch).step_by(n_ch).copied().collect()
}

/// Least-squares fit of `Σ a_k cos(w_k n) + b_k sin(w_k n) + c` over `x`; returns (amplitude,
/// phase) per frequency, with `x[n] ≈ A sin(w n + φ)`. `freqs` are in cycles per sample.
pub fn fit_sines(x: &[f64], freqs: &[f64]) -> Vec<(f64, f64)> {
    let k = freqs.len() * 2 + 1;
    let mut ata = vec![vec![0.0f64; k]; k];
    let mut atb = vec![0.0f64; k];
    let mut row = vec![0.0f64; k];
    for (n, &v) in x.iter().enumerate() {
        for (j, f) in freqs.iter().enumerate() {
            let w = 2.0 * std::f64::consts::PI * f * n as f64;
            row[2 * j] = w.sin();
            row[2 * j + 1] = w.cos();
        }
        row[k - 1] = 1.0;
        for a in 0..k {
            atb[a] += row[a] * v;
            for b in 0..k {
                ata[a][b] += row[a] * row[b];
            }
        }
    }
    let sol = solve(ata, atb);
    freqs
        .iter()
        .enumerate()
        .map(|(j, _)| {
            let (s, c) = (sol[2 * j], sol[2 * j + 1]);
            ((s * s + c * c).sqrt(), c.atan2(s))
        })
        .collect()
}

fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for i in 0..n {
        let p = (i..n).max_by(|&x, &y| a[x][i].abs().total_cmp(&a[y][i].abs())).unwrap();
        a.swap(i, p);
        b.swap(i, p);
        let (top, bottom) = a.split_at_mut(i + 1);
        let pivot = &top[i];
        for (r, row) in bottom.iter_mut().enumerate() {
            let f = row[i] / pivot[i];
            for (x, p) in row[i..].iter_mut().zip(&pivot[i..]) {
                *x -= f * p;
            }
            b[i + 1 + r] -= f * b[i];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let s: f64 = (i + 1..n).map(|c| a[i][c] * x[c]).sum();
        x[i] = (b[i] - s) / a[i][i];
    }
    x
}

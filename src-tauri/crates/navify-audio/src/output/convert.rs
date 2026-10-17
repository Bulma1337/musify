//! f64 → device sample format conversion.
//!
//! The engine hands the output f64 samples (the mixer's own precision), so every integer source up
//! to 32 bits arrives exactly: a 32-bit sample `k / 2^31` needs 32 significant bits, which f32
//! (24-bit mantissa) cannot hold, but f64 (53 bits) can.
//!
//! Rules (see the module contract in `output/mod.rs`):
//! - Float device formats receive the samples rounded to f32 (exact for 32-bit float and ≤ 24-bit
//!   integer sources) or unchanged (f64).
//! - 24- and 32-bit integer formats use plain rounding, no dither. Every f64 that represents a
//!   ≤ 24-bit integer sample (`k / 2^23`) converts back to exactly `k` (or `k << 8` in a 32-bit
//!   word), and every 32-bit sample (`k / 2^31`) to exactly `k`, so bit-perfect playback of 24- and
//!   32-bit sources is preserved.
//! - Formats with ≤ 16 bits use TPDF dither (±1 LSB, triangular) when, and only when, a sample is
//!   not already on the target grid. A 16-bit source therefore reaches a 16-bit device unchanged,
//!   and digital silence stays digital silence; higher-resolution content is dithered.
//! - Out-of-range values clip to the integer limits; NaN becomes 0.
//!
//! All multi-byte values are written in native byte order (what cpal expects; WASAPI on Windows is
//! little endian, which is native on every Windows target).

use crate::api::DeviceSampleFormat;

/// 2^23: full scale of a 24-bit sample.
const SCALE_24: f64 = 8_388_608.0;
/// 2^31: full scale of a 32-bit sample.
const SCALE_32: f64 = 2_147_483_648.0;
/// 2^63: full scale of a 64-bit sample.
const SCALE_64: f64 = 9_223_372_036_854_775_808.0;
/// 2^15: full scale of a 16-bit sample.
const SCALE_16: f64 = 32_768.0;
/// 2^7: full scale of an 8-bit sample.
const SCALE_8: f64 = 128.0;

const I24_MIN: i32 = -(1 << 23);
const I24_MAX: i32 = (1 << 23) - 1;

/// Layout of one sample in the device buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleEncoding {
    F32,
    F64,
    I8,
    U8,
    I16,
    U16,
    /// 24-bit value in the low bits of a 4-byte word (cpal's `I24`).
    I24In32Low,
    /// Unsigned 24-bit value (origin 2^23) in the low bits of a 4-byte word (cpal's `U24`).
    U24In32Low,
    /// 24-bit value in the high bits of a 4-byte word (WASAPI 32-bit container, 24 valid bits).
    I24In32High,
    /// Packed 3-byte 24-bit samples (WASAPI 24-in-24).
    I24Packed,
    I32,
    U32,
    I64,
    U64,
}

impl SampleEncoding {
    pub fn bytes_per_sample(self) -> usize {
        match self {
            SampleEncoding::I8 | SampleEncoding::U8 => 1,
            SampleEncoding::I16 | SampleEncoding::U16 => 2,
            SampleEncoding::I24Packed => 3,
            SampleEncoding::F32
            | SampleEncoding::I24In32Low
            | SampleEncoding::U24In32Low
            | SampleEncoding::I24In32High
            | SampleEncoding::I32
            | SampleEncoding::U32 => 4,
            SampleEncoding::F64 | SampleEncoding::I64 | SampleEncoding::U64 => 8,
        }
    }

    /// Significant bits of the encoding (`None` for float).
    pub fn valid_bits(self) -> Option<u32> {
        match self {
            SampleEncoding::F32 | SampleEncoding::F64 => None,
            SampleEncoding::I8 | SampleEncoding::U8 => Some(8),
            SampleEncoding::I16 | SampleEncoding::U16 => Some(16),
            SampleEncoding::I24In32Low
            | SampleEncoding::U24In32Low
            | SampleEncoding::I24In32High
            | SampleEncoding::I24Packed => Some(24),
            SampleEncoding::I32 | SampleEncoding::U32 => Some(32),
            SampleEncoding::I64 | SampleEncoding::U64 => Some(64),
        }
    }

    /// True when the conversion reduces resolution enough to require dither (≤ 16 bit).
    pub fn needs_dither(self) -> bool {
        matches!(self.valid_bits(), Some(bits) if bits <= 16)
    }

    /// The API-level description of this layout (unsigned and 8/64-bit integers are `Other`).
    pub fn device_format(self) -> DeviceSampleFormat {
        match self {
            SampleEncoding::F32 => DeviceSampleFormat::Float32,
            SampleEncoding::F64 => DeviceSampleFormat::Float64,
            SampleEncoding::I16 => DeviceSampleFormat::Int16,
            SampleEncoding::I24Packed => DeviceSampleFormat::Int24,
            SampleEncoding::I24In32High | SampleEncoding::I24In32Low => {
                DeviceSampleFormat::Int24In32
            }
            SampleEncoding::I32 => DeviceSampleFormat::Int32,
            SampleEncoding::I8
            | SampleEncoding::U8
            | SampleEncoding::U16
            | SampleEncoding::U24In32Low
            | SampleEncoding::U32
            | SampleEncoding::I64
            | SampleEncoding::U64 => DeviceSampleFormat::Other,
        }
    }
}

/// Exact for every value of the form `k / 2^23`; rounds to nearest otherwise; clips.
#[inline]
pub fn f64_to_i24(x: f64) -> i32 {
    // Scaling by a power of two is exact; `as` saturates and maps NaN to 0.
    ((x * SCALE_24).round() as i32).clamp(I24_MIN, I24_MAX)
}

/// Full 32-bit resolution: `k / 2^31` maps to exactly `k` (so `k / 2^23` to `k << 8`); clips.
#[inline]
pub fn f64_to_i32(x: f64) -> i32 {
    (x * SCALE_32).round() as i32
}

/// 64-bit integer (exact for every f64 in range with ≤ 63 fractional bits); clips.
#[inline]
pub fn f64_to_i64(x: f64) -> i64 {
    (x * SCALE_64).round() as i64
}

/// Quantizes `x` to a signed integer of `scale` full scale, dithering only off-grid samples.
#[inline]
fn quantize_dithered(x: f64, scale: f64, min: f64, max: f64, dither: &mut Tpdf) -> f64 {
    let v = x * scale;
    if !v.is_finite() {
        return if v.is_nan() { 0.0 } else { v.clamp(min, max) };
    }
    let rounded = v.round();
    let q = if rounded == v {
        v
    } else {
        (v + dither.sample()).round()
    };
    q.clamp(min, max)
}

/// 16-bit conversion: exact for samples already on the 16-bit grid, TPDF-dithered otherwise.
#[inline]
pub fn f64_to_i16_dithered(x: f64, dither: &mut Tpdf) -> i16 {
    quantize_dithered(x, SCALE_16, -32_768.0, 32_767.0, dither) as i16
}

/// 8-bit conversion: exact for samples already on the 8-bit grid, TPDF-dithered otherwise.
#[inline]
pub fn f64_to_i8_dithered(x: f64, dither: &mut Tpdf) -> i8 {
    quantize_dithered(x, SCALE_8, -128.0, 127.0, dither) as i8
}

/// Triangular-PDF dither source: the sum of two independent uniform variables, ±1 LSB peak.
/// xorshift32, allocation- and lock-free.
#[derive(Clone, Debug)]
pub struct Tpdf {
    state: u32,
}

impl Default for Tpdf {
    fn default() -> Self {
        Self::new(0x9E37_79B9)
    }
}

impl Tpdf {
    pub fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 0x9E37_79B9 } else { seed },
        }
    }

    #[inline]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x
    }

    /// Uniform in [0, 1).
    #[inline]
    fn uniform(&mut self) -> f64 {
        f64::from(self.next_u32() >> 8) * (1.0 / 16_777_216.0)
    }

    /// Triangular value in (-1, 1) LSB.
    #[inline]
    pub fn sample(&mut self) -> f64 {
        self.uniform() - self.uniform()
    }
}

/// Converts f64 samples into a device byte buffer.
#[derive(Clone, Debug)]
pub struct Encoder {
    encoding: SampleEncoding,
    dither: Tpdf,
}

impl Encoder {
    pub fn new(encoding: SampleEncoding) -> Self {
        Self {
            encoding,
            dither: Tpdf::default(),
        }
    }

    pub fn encoding(&self) -> SampleEncoding {
        self.encoding
    }

    /// Encodes `src` into `dst`; `dst.len()` must be `src.len() * bytes_per_sample` (extra bytes are
    /// left untouched, missing bytes truncate the conversion). Never allocates.
    pub fn encode(&mut self, src: &[f64], dst: &mut [u8]) {
        let bps = self.encoding.bytes_per_sample();
        let dither = &mut self.dither;
        let pairs = src.iter().zip(dst.chunks_exact_mut(bps));
        match self.encoding {
            SampleEncoding::F32 => {
                pairs.for_each(|(&x, d)| d.copy_from_slice(&(x as f32).to_ne_bytes()))
            }
            SampleEncoding::F64 => pairs.for_each(|(&x, d)| d.copy_from_slice(&x.to_ne_bytes())),
            SampleEncoding::I8 => {
                pairs.for_each(|(&x, d)| d[0] = f64_to_i8_dithered(x, dither) as u8)
            }
            SampleEncoding::U8 => {
                pairs.for_each(|(&x, d)| d[0] = (f64_to_i8_dithered(x, dither) as u8) ^ 0x80)
            }
            SampleEncoding::I16 => pairs.for_each(|(&x, d)| {
                d.copy_from_slice(&f64_to_i16_dithered(x, dither).to_ne_bytes())
            }),
            SampleEncoding::U16 => pairs.for_each(|(&x, d)| {
                let v = (f64_to_i16_dithered(x, dither) as u16) ^ 0x8000;
                d.copy_from_slice(&v.to_ne_bytes())
            }),
            SampleEncoding::I24In32Low => {
                pairs.for_each(|(&x, d)| d.copy_from_slice(&f64_to_i24(x).to_ne_bytes()))
            }
            SampleEncoding::U24In32Low => pairs.for_each(|(&x, d)| {
                let v = (f64_to_i24(x) + (1 << 23)) as u32;
                d.copy_from_slice(&v.to_ne_bytes())
            }),
            SampleEncoding::I24In32High => {
                pairs.for_each(|(&x, d)| d.copy_from_slice(&(f64_to_i24(x) << 8).to_ne_bytes()))
            }
            SampleEncoding::I24Packed => pairs.for_each(|(&x, d)| {
                let b = f64_to_i24(x).to_le_bytes();
                if cfg!(target_endian = "little") {
                    d.copy_from_slice(&b[..3]);
                } else {
                    d.copy_from_slice(&[b[2], b[1], b[0]]);
                }
            }),
            SampleEncoding::I32 => {
                pairs.for_each(|(&x, d)| d.copy_from_slice(&f64_to_i32(x).to_ne_bytes()))
            }
            SampleEncoding::U32 => pairs.for_each(|(&x, d)| {
                let v = (f64_to_i32(x) as u32) ^ 0x8000_0000;
                d.copy_from_slice(&v.to_ne_bytes())
            }),
            SampleEncoding::I64 => {
                pairs.for_each(|(&x, d)| d.copy_from_slice(&f64_to_i64(x).to_ne_bytes()))
            }
            SampleEncoding::U64 => pairs.for_each(|(&x, d)| {
                let v = (f64_to_i64(x) as u64) ^ 0x8000_0000_0000_0000;
                d.copy_from_slice(&v.to_ne_bytes())
            }),
        }
    }
}

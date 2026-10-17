//! Exclusive-mode rate and sample-format negotiation. Pure functions, shared by the WASAPI backend,
//! the engine (to predict whether the next track needs a device reopen) and the tests.
//!
//! Policy:
//! - **Rate:** the track's native rate if the device accepts it. Otherwise prefer the same rate
//!   family (multiples of 44.1 kHz vs. 48 kHz, so the resampler ratio stays simple): the lowest
//!   supported rate above the native one (no information is lost), else the highest one below it.
//!   Then the other family with the same rule, then any other rate. The engine resamples to the
//!   chosen rate with its high-quality resampler and stays in exclusive mode.
//! - **Sample format:** the highest integer resolution the device accepts (32-in-32, 24-in-32,
//!   packed 24), float only if nothing else; 16 bit last. Floating-point sources (32-bit float
//!   WAV) prefer 32-bit float, the only format that carries them unchanged.

use crate::api::{DeviceSampleFormat, ExclusiveCaps};

/// Rates probed for exclusive-mode support (Hz).
pub const PROBE_RATES: [u32; 10] = [
    44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000, 705_600, 768_000,
];

/// Preference for integer (and lossy) sources.
pub const INT_PREFERENCE: [DeviceSampleFormat; 5] = [
    DeviceSampleFormat::Int32,
    DeviceSampleFormat::Int24In32,
    DeviceSampleFormat::Int24,
    DeviceSampleFormat::Float32,
    DeviceSampleFormat::Int16,
];

/// Preference for floating-point sources.
pub const FLOAT_PREFERENCE: [DeviceSampleFormat; 5] = [
    DeviceSampleFormat::Float32,
    DeviceSampleFormat::Int32,
    DeviceSampleFormat::Int24In32,
    DeviceSampleFormat::Int24,
    DeviceSampleFormat::Int16,
];

/// The track an exclusive stream is opened for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SourceSpec {
    pub sample_rate: u32,
    /// Bits per sample of lossless sources (`None` for lossy sources).
    pub bits: Option<u32>,
    /// Floating-point PCM.
    pub float: bool,
}

impl SourceSpec {
    /// Device sample formats in order of preference for this source.
    pub fn format_preference(&self) -> &'static [DeviceSampleFormat] {
        if self.float && self.bits.is_some() {
            &FLOAT_PREFERENCE
        } else {
            &INT_PREFERENCE
        }
    }
}

/// 44_100 for the 44.1 kHz family, 48_000 for the 48 kHz family, 0 for anything else.
pub fn rate_family(rate: u32) -> u32 {
    if rate == 0 {
        0
    } else if rate.is_multiple_of(11_025) {
        44_100
    } else if rate.is_multiple_of(4_000) {
        48_000
    } else {
        0
    }
}

/// `supported` rates ordered by preference for a track at `native` Hz (see the module docs).
pub fn rank_rates(native: u32, supported: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut rates: Vec<u32> = supported.into_iter().filter(|&r| r > 0).collect();
    rates.sort_unstable();
    rates.dedup();
    let native_family = rate_family(native);
    rates.sort_by_key(|&r| {
        if r == native {
            return (0u8, 0u32);
        }
        let family = rate_family(r);
        let group = if family != 0 && family == native_family {
            1
        } else if family != 0 {
            3
        } else {
            5
        };
        if r > native {
            (group, r)
        } else {
            (group + 1, u32::MAX - r)
        }
    });
    rates
}

/// Rate and sample format an exclusive stream should use for `source` on a device with `caps`.
/// `None` if the device supports no exclusive format at all.
pub fn choose(caps: &ExclusiveCaps, source: &SourceSpec) -> Option<(u32, DeviceSampleFormat)> {
    let rate = *rank_rates(source.sample_rate, caps.rates()).first()?;
    let formats = caps.formats_at(rate);
    let format = source
        .format_preference()
        .iter()
        .copied()
        .find(|f| formats.contains(f))
        .or_else(|| formats.first().copied())?;
    Some((rate, format))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ExclusiveMode;

    fn caps(rates: &[u32], formats: &[DeviceSampleFormat]) -> ExclusiveCaps {
        ExclusiveCaps {
            modes: rates
                .iter()
                .map(|&sample_rate| ExclusiveMode {
                    sample_rate,
                    formats: formats.to_vec(),
                })
                .collect(),
        }
    }

    #[test]
    fn families() {
        for r in [11_025, 22_050, 44_100, 88_200, 176_400, 352_800, 705_600] {
            assert_eq!(rate_family(r), 44_100, "{r}");
        }
        for r in [
            8_000, 16_000, 32_000, 48_000, 96_000, 192_000, 384_000, 768_000,
        ] {
            assert_eq!(rate_family(r), 48_000, "{r}");
        }
        assert_eq!(rate_family(44_099), 0);
    }

    #[test]
    fn native_rate_first_then_same_family_up_then_down_then_other_family() {
        let all = PROBE_RATES;
        assert_eq!(rank_rates(192_000, all)[0], 192_000);
        // 352.8 kHz on a device that stops at 192 kHz: highest 44.1k-family rate below.
        let to_192 = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];
        assert_eq!(
            rank_rates(352_800, to_192),
            vec![176_400, 88_200, 44_100, 192_000, 96_000, 48_000]
        );
        // 44.1 kHz on a 48 kHz-family-only device: lowest rate above in the other family.
        assert_eq!(rank_rates(44_100, [48_000, 96_000]), vec![48_000, 96_000]);
        // 88.2 kHz without 88.2: 176.4 (up, same family) beats 44.1 (down).
        assert_eq!(
            rank_rates(88_200, [44_100, 48_000, 96_000, 176_400])[0],
            176_400
        );
        // 192 kHz on a 44.1/48/88.2/96 device: 96 kHz (same family, highest below).
        assert_eq!(
            rank_rates(192_000, [44_100, 48_000, 88_200, 96_000])[0],
            96_000
        );
        // Odd rates go last.
        assert_eq!(rank_rates(48_000, [44_099, 44_100]), vec![44_100, 44_099]);
        assert!(rank_rates(48_000, []).is_empty());
    }

    #[test]
    fn formats_prefer_integer_depth_and_float_for_float_sources() {
        use DeviceSampleFormat::*;
        let c = caps(&[96_000], &[Int16, Float32, Int24In32, Int32]);
        let int24 = SourceSpec {
            sample_rate: 96_000,
            bits: Some(24),
            float: false,
        };
        assert_eq!(choose(&c, &int24), Some((96_000, Int32)));
        let float32 = SourceSpec {
            float: true,
            bits: Some(32),
            ..int24
        };
        assert_eq!(choose(&c, &float32), Some((96_000, Float32)));
        let lossy = SourceSpec {
            bits: None,
            ..int24
        };
        assert_eq!(choose(&c, &lossy), Some((96_000, Int32)));
        let packed = caps(&[44_100], &[Int16, Int24]);
        assert_eq!(choose(&packed, &int24), Some((44_100, Int24)));
        let only_float = caps(&[48_000], &[Float32]);
        assert_eq!(choose(&only_float, &int24), Some((48_000, Float32)));
        assert_eq!(choose(&ExclusiveCaps::default(), &int24), None);
    }

    #[test]
    fn carries_requires_enough_integer_bits_or_float_for_float_sources() {
        use DeviceSampleFormat::*;
        assert!(Int24In32.carries(Some(24), false));
        assert!(Int32.carries(Some(16), false));
        assert!(!Int24.carries(Some(32), false));
        assert!(Int32.carries(Some(32), false));
        assert!(!Float32.carries(Some(24), false));
        assert!(Float32.carries(Some(32), true));
        assert!(!Int32.carries(Some(32), true));
        assert!(!Float32.carries(Some(64), true));
        assert!(Int32.carries(None, false));
        assert!(Int24.carries(None, false));
        assert!(Float32.carries(None, false));
        assert!(!Int16.carries(None, false));
    }
}

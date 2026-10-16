//! ReplayGain / R128 extraction from symphonia's metadata.
//!
//! Sources (all read through symphonia's own metadata readers):
//! - Vorbis comments (FLAC, Ogg Vorbis, Ogg Opus): `REPLAYGAIN_TRACK_GAIN` etc.
//! - ID3v2 `TXXX:REPLAYGAIN_*` frames and APEv2 items (MP3).
//! - MP4 freeform atoms `----:com.apple.iTunes:replaygain_*`.
//! - Opus `R128_TRACK_GAIN` / `R128_ALBUM_GAIN`: Q7.8 dB relative to −23 LUFS, converted to the
//!   ReplayGain 2.0 reference of −18 LUFS as `gain_db = r128 / 256 + 5`. These are relative to the
//!   Opus header output gain, which the decoder already applies to the samples (RFC 7845 §5.2.1).

use symphonia::core::meta::{MetadataRevision, RawValue, StandardTag, Tag};

use crate::api::ReplayGainInfo;

#[derive(Default, Debug, Clone, Copy)]
pub(crate) struct GainTags {
    rg: ReplayGainInfo,
    r128_track: Option<f64>,
    r128_album: Option<f64>,
}

impl GainTags {
    pub(crate) fn add_revision(&mut self, rev: &MetadataRevision) {
        for tag in rev.media.tags.iter().chain(rev.per_track.iter().flat_map(|t| t.metadata.tags.iter())) {
            self.add_tag(tag);
        }
    }

    pub(crate) fn add_tag(&mut self, tag: &Tag) {
        let value = match &tag.raw.value {
            RawValue::String(s) => s.as_str().to_owned(),
            RawValue::StringList(l) => l.first().cloned().unwrap_or_default(),
            RawValue::Float(f) => f.to_string(),
            RawValue::SignedInt(i) => i.to_string(),
            RawValue::UnsignedInt(u) => u.to_string(),
            _ => return,
        };
        let std_kind = match &tag.std {
            Some(StandardTag::ReplayGainTrackGain(_)) => Some(Kind::TrackGain),
            Some(StandardTag::ReplayGainTrackPeak(_)) => Some(Kind::TrackPeak),
            Some(StandardTag::ReplayGainAlbumGain(_)) => Some(Kind::AlbumGain),
            Some(StandardTag::ReplayGainAlbumPeak(_)) => Some(Kind::AlbumPeak),
            _ => None,
        };
        let Some(kind) = std_kind.or_else(|| kind_from_key(&tag.raw.key)) else { return };
        self.set(kind, &value);
    }

    /// Sets a value from a raw key/value pair (used for tests and non-symphonia sources).
    pub(crate) fn add_raw(&mut self, key: &str, value: &str) {
        if let Some(kind) = kind_from_key(key) {
            self.set(kind, value);
        }
    }

    fn set(&mut self, kind: Kind, value: &str) {
        match kind {
            Kind::TrackGain => set_once(&mut self.rg.track_gain_db, parse_db(value)),
            Kind::AlbumGain => set_once(&mut self.rg.album_gain_db, parse_db(value)),
            Kind::TrackPeak => set_once(&mut self.rg.track_peak, parse_peak(value)),
            Kind::AlbumPeak => set_once(&mut self.rg.album_peak, parse_peak(value)),
            Kind::R128Track => set_once(&mut self.r128_track, parse_r128(value)),
            Kind::R128Album => set_once(&mut self.r128_album, parse_r128(value)),
        }
    }

    /// Final values. For Opus the R128 tags take precedence (they are the format's native gain
    /// tags); everywhere else ReplayGain tags win and R128 only fills gaps.
    pub(crate) fn finish(&self, prefer_r128: bool) -> Option<ReplayGainInfo> {
        let mut out = self.rg;
        let pick = |rg: Option<f64>, r128: Option<f64>| if prefer_r128 { r128.or(rg) } else { rg.or(r128) };
        out.track_gain_db = pick(out.track_gain_db, self.r128_track);
        out.album_gain_db = pick(out.album_gain_db, self.r128_album);
        (out != ReplayGainInfo::default()).then_some(out)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    TrackGain,
    TrackPeak,
    AlbumGain,
    AlbumPeak,
    R128Track,
    R128Album,
}

/// Matches the bare key as well as namespaced variants such as `TXXX:replaygain_track_gain` or
/// `----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN`.
fn kind_from_key(key: &str) -> Option<Kind> {
    let name = key.rsplit([':', '/']).next().unwrap_or(key).trim().to_ascii_uppercase();
    Some(match name.as_str() {
        "REPLAYGAIN_TRACK_GAIN" => Kind::TrackGain,
        "REPLAYGAIN_TRACK_PEAK" => Kind::TrackPeak,
        "REPLAYGAIN_ALBUM_GAIN" => Kind::AlbumGain,
        "REPLAYGAIN_ALBUM_PEAK" => Kind::AlbumPeak,
        "R128_TRACK_GAIN" => Kind::R128Track,
        "R128_ALBUM_GAIN" => Kind::R128Album,
        _ => return None,
    })
}

fn set_once(slot: &mut Option<f64>, value: Option<f64>) {
    if slot.is_none() {
        *slot = value;
    }
}

/// Parses the leading number of strings like `"-6.50 dB"`, `"+1.2dB"`, `" 0.988"`.
fn leading_number(s: &str) -> Option<f64> {
    let s = s.trim().trim_start_matches('+');
    let end = s
        .char_indices()
        .find(|&(i, c)| !(c.is_ascii_digit() || c == '.' || ((c == '-' || c == '+') && i == 0)))
        .map_or(s.len(), |(i, _)| i);
    let v: f64 = s[..end].replace(',', ".").parse().ok()?;
    v.is_finite().then_some(v)
}

fn parse_db(s: &str) -> Option<f64> {
    leading_number(&s.replace(',', ".")).filter(|v| v.abs() <= 64.0)
}

fn parse_peak(s: &str) -> Option<f64> {
    leading_number(&s.replace(',', ".")).filter(|v| *v >= 0.0 && *v <= 64.0)
}

/// R128 gains are signed Q7.8 integers relative to −23 LUFS. ReplayGain 2.0 uses −18 LUFS, so
/// the same loudness needs 5 dB more gain.
fn parse_r128(s: &str) -> Option<f64> {
    let q: i32 = s.trim().parse().ok()?;
    if !(-32768..=32767).contains(&q) {
        return None;
    }
    Some(f64::from(q) / 256.0 + 5.0)
}

/// Opus identification header output gain (RFC 7845 §5.1, Q7.8 dB), as a linear factor.
pub(crate) fn opus_header_gain(extra_data: &[u8]) -> Option<f64> {
    if extra_data.len() < 19 || &extra_data[..8] != b"OpusHead" {
        return None;
    }
    let q = i16::from_le_bytes([extra_data[16], extra_data[17]]);
    (q != 0).then(|| 10f64.powf(f64::from(q) / 256.0 / 20.0))
}

/// Opus identification header pre-skip in 48 kHz samples.
pub(crate) fn opus_pre_skip(extra_data: &[u8]) -> Option<u64> {
    if extra_data.len() < 19 || &extra_data[..8] != b"OpusHead" {
        return None;
    }
    Some(u64::from(u16::from_le_bytes([extra_data[10], extra_data[11]])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replaygain_strings() {
        assert_eq!(parse_db("-6.50 dB"), Some(-6.5));
        assert_eq!(parse_db("+1.25 dB"), Some(1.25));
        assert_eq!(parse_db("3,5 dB"), Some(3.5));
        assert_eq!(parse_db("garbage"), None);
        assert_eq!(parse_peak("0.988"), Some(0.988));
        assert_eq!(parse_peak("-1"), None);
    }

    #[test]
    fn r128_converts_to_rg2_reference() {
        assert_eq!(parse_r128("-2560"), Some(-5.0));
        assert_eq!(parse_r128("0"), Some(5.0));
        assert_eq!(parse_r128("256"), Some(6.0));
        assert_eq!(parse_r128("99999"), None);
    }

    #[test]
    fn keys_match_with_namespaces() {
        let mut g = GainTags::default();
        g.add_raw("TXXX:replaygain_track_gain", "-3 dB");
        g.add_raw("----:com.apple.iTunes:REPLAYGAIN_ALBUM_GAIN", "-4.5 dB");
        g.add_raw("REPLAYGAIN_TRACK_PEAK", "0.5");
        g.add_raw("R128_ALBUM_GAIN", "512");
        let rg = g.finish(false).unwrap();
        assert_eq!(rg.track_gain_db, Some(-3.0));
        assert_eq!(rg.album_gain_db, Some(-4.5));
        assert_eq!(rg.track_peak, Some(0.5));
        let rg = g.finish(true).unwrap();
        assert_eq!(rg.album_gain_db, Some(7.0));
        assert!(GainTags::default().finish(false).is_none());
    }

    #[test]
    fn opus_head_fields() {
        let mut head = b"OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00".to_vec();
        assert_eq!(opus_pre_skip(&head), Some(312));
        assert_eq!(opus_header_gain(&head), None);
        head[16] = 0x00;
        head[17] = 0x06; // +6 dB
        let g = opus_header_gain(&head).unwrap();
        assert!((20.0 * g.log10() - 6.0).abs() < 1e-12);
    }
}

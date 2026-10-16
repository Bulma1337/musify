//! Gapless information that symphonia does not apply itself: MP4 / M4A edit lists and iTunSMPB.
//!
//! symphonia 0.6 parses `elst` but ignores it, and does not read iTunSMPB. Both describe the
//! encoder priming ("delay") and the valid length:
//! - ffmpeg writes `elst` with `media_time` = priming (1024 for its AAC encoder, 0 for ALAC) and
//!   `segment_duration` = valid length in movie timescale units (ffmpeg ≥ 5 uses the sample rate as
//!   movie timescale, so this is exact); the last `stts` delta is shortened to the valid length too.
//! - Apple (iTunes / afconvert) writes iTunSMPB (` 00000000 <delay> <padding> <total> …`, hex) and
//!   usually an equivalent `elst`.
//!
//! The scan reads only atom headers and the `moov` box (seeking over `mdat`), then rewinds.

use std::io::{self, SeekFrom};

use crate::source::ByteSource;

/// Largest `moov` we are willing to load (sample tables of a multi-hour file are a few MB).
const MAX_MOOV: u64 = 64 << 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Mp4Timing {
    pub movie_timescale: u32,
    pub media_timescale: u32,
    /// First non-empty edit: (segment_duration in movie units, media_time in media units).
    pub edit: Option<(u64, u64)>,
    /// iTunSMPB (delay, padding, total valid samples).
    pub itunsmpb: Option<(u64, u64, u64)>,
}

/// The valid range of an MP4 track in decoded frames: skip `start` frames, then keep `len`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Window {
    pub start: u64,
    pub len: Option<u64>,
}

impl Mp4Timing {
    /// `total_frames` is the summed `stts` duration in frames (if known).
    pub(crate) fn window(&self, sample_rate: u32, total_frames: Option<u64>) -> Option<Window> {
        let sr = u128::from(sample_rate);
        let rescale = |v: u64, ts: u32| -> u64 {
            if ts == 0 {
                return v;
            }
            let ts = u128::from(ts);
            ((u128::from(v) * sr + ts / 2) / ts) as u64
        };
        if let Some((delay, _padding, total)) = self.itunsmpb
            && total > 0
        {
            let len = match total_frames {
                Some(t) => total.min(t.saturating_sub(delay)),
                None => total,
            };
            return Some(Window { start: delay, len: Some(len) });
        }
        let (seg, media_time) = self.edit?;
        let start = rescale(media_time, self.media_timescale);
        let avail = total_frames.map(|t| t.saturating_sub(start));
        let len = if seg == 0 {
            avail
        } else {
            let edit_len = rescale(seg, self.movie_timescale);
            // A coarse movie timescale (e.g. 600 or 1000) cannot express the length exactly; if the
            // sample table ends within one movie tick of the edit, the sample table is exact.
            let tick = if self.movie_timescale == 0 { 0 } else { (sr as u64).div_ceil(u64::from(self.movie_timescale)) };
            match avail {
                Some(a) if a.abs_diff(edit_len) <= tick => Some(a),
                Some(a) => Some(edit_len.min(a)),
                None => Some(edit_len),
            }
        };
        if start == 0 && len == total_frames {
            return None;
        }
        Some(Window { start, len })
    }
}

/// Scans an ISO-BMFF file for the first audio track's timing. Returns `Ok(None)` if the source is
/// not MP4. The source position is restored to 0.
pub(crate) fn scan_mp4(src: &mut dyn ByteSource) -> io::Result<Option<Mp4Timing>> {
    let result = scan_inner(src);
    src.seek(SeekFrom::Start(0))?;
    result
}

fn read_header(src: &mut dyn ByteSource) -> io::Result<Option<(u64, [u8; 4], u64)>> {
    let mut h = [0u8; 8];
    match src.read_exact(&mut h) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
    let kind = [h[4], h[5], h[6], h[7]];
    let (size, hdr) = if size32 == 1 {
        let mut b = [0u8; 8];
        src.read_exact(&mut b)?;
        (u64::from_be_bytes(b), 16)
    } else {
        (u64::from(size32), 8)
    };
    Ok(Some((size, kind, hdr)))
}

fn scan_inner(src: &mut dyn ByteSource) -> io::Result<Option<Mp4Timing>> {
    src.seek(SeekFrom::Start(0))?;
    let mut pos = 0u64;
    let mut first = true;
    loop {
        src.seek(SeekFrom::Start(pos))?;
        let Some((size, kind, hdr)) = read_header(src)? else { return Ok(None) };
        if first && &kind != b"ftyp" {
            return Ok(None);
        }
        first = false;
        if &kind == b"moov" {
            if size == 0 || size < hdr || size - hdr > MAX_MOOV {
                return Ok(None);
            }
            let mut body = vec![0u8; (size - hdr) as usize];
            src.read_exact(&mut body)?;
            return Ok(parse_moov(&body));
        }
        if size == 0 || size < hdr {
            return Ok(None); // atom extends to EOF (or broken) and it is not moov
        }
        pos = pos.checked_add(size).ok_or_else(|| io::Error::other("atom size overflow"))?;
    }
}

/// Iterates the child atoms of a box body: (type, body).
fn children(mut data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        if data.len() < 8 {
            return None;
        }
        let size32 = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as u64;
        let kind = [data[4], data[5], data[6], data[7]];
        let (size, hdr) = match size32 {
            0 => (data.len() as u64, 8),
            1 if data.len() >= 16 => (u64::from_be_bytes(data[8..16].try_into().ok()?), 16),
            1 => return None,
            s => (s, 8),
        };
        if size < hdr || size > data.len() as u64 {
            return None;
        }
        let body = &data[hdr as usize..size as usize];
        data = &data[size as usize..];
        Some((kind, body))
    })
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// mvhd / mdhd: timescale field.
fn header_timescale(body: &[u8]) -> Option<u32> {
    match body.first()? {
        1 => be_u32(body, 20),
        _ => be_u32(body, 12),
    }
}

fn parse_moov(moov: &[u8]) -> Option<Mp4Timing> {
    let mut t = Mp4Timing::default();
    let mut found_audio = false;
    for (kind, body) in children(moov) {
        match &kind {
            b"mvhd" => t.movie_timescale = header_timescale(body).unwrap_or(0),
            b"trak" if !found_audio => {
                if let Some((media_ts, edit)) = parse_trak(body) {
                    found_audio = true;
                    t.media_timescale = media_ts;
                    t.edit = edit;
                }
            }
            b"udta" => {
                if let Some(smpb) = find_itunsmpb(body) {
                    t.itunsmpb = Some(smpb);
                }
            }
            _ => {}
        }
    }
    found_audio.then_some(t)
}

/// Returns (media timescale, first non-empty edit) for a sound track.
fn parse_trak(trak: &[u8]) -> Option<(u32, Option<(u64, u64)>)> {
    let mut edit = None;
    let mut media_ts = None;
    let mut is_sound = false;
    for (kind, body) in children(trak) {
        match &kind {
            b"edts" => {
                for (k, elst) in children(body) {
                    if &k == b"elst" {
                        edit = parse_elst(elst);
                    }
                }
            }
            b"mdia" => {
                for (k, b) in children(body) {
                    match &k {
                        b"mdhd" => media_ts = header_timescale(b),
                        b"hdlr" => is_sound = b.get(8..12) == Some(b"soun"),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    is_sound.then(|| (media_ts.unwrap_or(0), edit))
}

fn parse_elst(b: &[u8]) -> Option<(u64, u64)> {
    let version = *b.first()?;
    let count = be_u32(b, 4)? as usize;
    let mut at = 8;
    for _ in 0..count.min(1024) {
        let (seg, media_time, step) = if version == 1 {
            (be_u64(b, at)?, be_u64(b, at + 8)? as i64, 20)
        } else {
            (u64::from(be_u32(b, at)?), i64::from(be_u32(b, at + 4)? as i32), 12)
        };
        at += step;
        if media_time >= 0 {
            return Some((seg, media_time as u64));
        }
    }
    None
}

/// udta → meta → ilst → `----` (mean "com.apple.iTunes", name "iTunSMPB", data).
fn find_itunsmpb(udta: &[u8]) -> Option<(u64, u64, u64)> {
    for (kind, meta) in children(udta) {
        if &kind != b"meta" {
            continue;
        }
        // `meta` is a full box in MP4 but a plain container in QuickTime files.
        let meta_body = if meta.get(4..8) == Some(b"hdlr") { meta } else { meta.get(4..)? };
        for (k, ilst) in children(meta_body) {
            if &k != b"ilst" {
                continue;
            }
            for (k, item) in children(ilst) {
                if &k != b"----" {
                    continue;
                }
                let mut name = None;
                let mut data = None;
                for (k, b) in children(item) {
                    match &k {
                        b"name" => name = b.get(4..),
                        b"data" => data = b.get(8..),
                        _ => {}
                    }
                }
                if name.is_some_and(|n| n.eq_ignore_ascii_case(b"iTunSMPB")) {
                    return data.and_then(parse_itunsmpb);
                }
            }
        }
    }
    None
}

pub(crate) fn parse_itunsmpb(data: &[u8]) -> Option<(u64, u64, u64)> {
    let s = std::str::from_utf8(data).ok()?;
    let words: Vec<u64> = s.split_whitespace().take(4).map(|w| u64::from_str_radix(w, 16)).collect::<Result<_, _>>().ok()?;
    match words.as_slice() {
        [_, delay, padding, total] => Some((*delay, *padding, *total)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn itunsmpb_parses() {
        let s = b" 00000000 00000840 000001CA 00000000003F31F6 00000000 00000000";
        assert_eq!(parse_itunsmpb(s), Some((0x840, 0x1ca, 0x3f31f6)));
        assert_eq!(parse_itunsmpb(b"nonsense"), None);
    }

    #[test]
    fn windows() {
        let ffmpeg_aac = Mp4Timing { movie_timescale: 44100, media_timescale: 44100, edit: Some((29399, 1024)), itunsmpb: None };
        assert_eq!(ffmpeg_aac.window(44100, Some(30423)), Some(Window { start: 1024, len: Some(29399) }));
        // Coarse movie timescale: trust the sample table if it agrees within a tick.
        let coarse = Mp4Timing { movie_timescale: 1000, media_timescale: 44100, edit: Some((667, 1024)), itunsmpb: None };
        assert_eq!(coarse.window(44100, Some(30423)), Some(Window { start: 1024, len: Some(29399) }));
        let apple = Mp4Timing { movie_timescale: 600, media_timescale: 44100, edit: Some((400, 2112)), itunsmpb: Some((2112, 400, 30000)) };
        assert_eq!(apple.window(44100, Some(33792)), Some(Window { start: 2112, len: Some(30000) }));
        let alac = Mp4Timing { movie_timescale: 44100, media_timescale: 44100, edit: Some((29399, 0)), itunsmpb: None };
        assert_eq!(alac.window(44100, Some(29399)), None);
    }
}

//! The symphonia-based decoder behind [`super::Decoder`]: probing, gapless trimming on a single
//! frame timeline, sample-accurate seeking and error recovery.
//!
//! # Timeline
//!
//! Everything is tracked in *frame timestamps*: symphonia packet timestamps converted to frames at
//! the native sample rate. `origin` is the frame timestamp of output position 0 and `end_ts` (if
//! set) the exclusive end of valid content:
//!
//! | format | origin | end | who trims |
//! |---|---|---|---|
//! | MP3 (LAME/Xing) | 0 | — | symphonia demuxer + decoder (delay + 529, padding) |
//! | Ogg Vorbis / FLAC-in-Ogg | 0 | — | symphonia (granule positions) |
//! | Ogg Opus | pre-skip | — | libopus adapter (pre-skip), symphonia (end granule) |
//! | MP4 AAC / ALAC | edit `media_time` / iTunSMPB delay | + valid length | this module |
//! | FLAC / WAV / AIFF / CAF | 0 | — | nothing to trim (exact) |
//!
//! symphonia's MP3 and Vorbis decoders and the libopus adapter honour the packets' `trim_start` /
//! `trim_end`; for every other codec this module applies them itself, so trimming never happens
//! twice or not at all.

use std::sync::Arc;

use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::well_known::*;
use symphonia::core::codecs::audio::{AudioCodecId, AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::{Error as SymError, SeekErrorKind};
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::well_known::FORMAT_ID_OGG;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::packet::Packet;
use symphonia::core::units::{Duration, TimeBase, Timestamp};

use super::channel_map::ChannelLayout;
use super::gapless::{self, Window};
use super::media_source::ByteSourceMedia;
use super::tags::{self, GainTags};
use super::{DecodeError, DecodedInfo, registry};
use crate::api::SourceFormat;
use crate::source::ByteSource;

/// Consecutive undecodable packets / demuxer errors tolerated before giving up.
const MAX_CONSECUTIVE_ERRORS: u32 = 64;
/// Longest silence inserted for one undecodable packet (frames = this × sample rate / 1000).
const MAX_CONCEAL_MS: u64 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodecKind {
    Pcm,
    Flac,
    Alac,
    Mp3,
    Mp2,
    Mp1,
    Aac,
    Vorbis,
    Opus,
    Adpcm,
    Other,
}

impl CodecKind {
    fn from_id(id: AudioCodecId) -> Self {
        match id {
            CODEC_ID_FLAC => Self::Flac,
            CODEC_ID_ALAC => Self::Alac,
            CODEC_ID_MP3 => Self::Mp3,
            CODEC_ID_MP2 => Self::Mp2,
            CODEC_ID_MP1 => Self::Mp1,
            CODEC_ID_AAC => Self::Aac,
            CODEC_ID_VORBIS => Self::Vorbis,
            CODEC_ID_OPUS => Self::Opus,
            CODEC_ID_ADPCM_G722 | CODEC_ID_ADPCM_G726 | CODEC_ID_ADPCM_G726LE | CODEC_ID_ADPCM_MS
            | CODEC_ID_ADPCM_IMA_WAV | CODEC_ID_ADPCM_IMA_QT => Self::Adpcm,
            id if (CODEC_ID_PCM_S32LE..=CODEC_ID_PCM_MULAW).contains(&id) => Self::Pcm,
            _ => Self::Other,
        }
    }

    fn name(self) -> Option<&'static str> {
        Some(match self {
            Self::Pcm => "PCM",
            Self::Flac => "FLAC",
            Self::Alac => "ALAC",
            Self::Mp3 => "MP3",
            Self::Mp2 => "MP2",
            Self::Mp1 => "MP1",
            Self::Aac => "AAC",
            Self::Vorbis => "Vorbis",
            Self::Opus => "Opus",
            Self::Adpcm => "ADPCM",
            Self::Other => return None,
        })
    }

    fn lossless(self, id: AudioCodecId) -> bool {
        match self {
            Self::Flac | Self::Alac => true,
            Self::Pcm => !matches!(id, CODEC_ID_PCM_ALAW | CODEC_ID_PCM_MULAW),
            _ => matches!(id, CODEC_ID_WAVPACK | CODEC_ID_TTA | CODEC_ID_MONKEYS_AUDIO | CODEC_ID_TRUEHD),
        }
    }

    /// Frames decoded (and discarded) before a seek target so that decoder state (MDCT overlap,
    /// bit reservoir, Opus predictors) has converged at the target.
    fn preroll(self, sample_rate: u32) -> u64 {
        match self {
            Self::Mp3 | Self::Mp2 | Self::Mp1 => 2 * 1152,
            Self::Aac => 2 * 1024,
            Self::Vorbis => 8192,
            // RFC 7845 §4.6 asks for at least 80 ms; measured: after 80 ms the libopus state still
            // deviates by up to −25 dBFS, after 400 ms by < −115 dBFS (≈ 1–2 ms of CPU per seek).
            Self::Opus => u64::from(sample_rate) * 400 / 1000,
            Self::Adpcm | Self::Other => 4096,
            Self::Pcm | Self::Flac | Self::Alac => 0,
        }
    }
}

pub(crate) struct Engine {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
    pub(crate) layout: ChannelLayout,
    codec: CodecKind,
    origin: i64,
    end_ts: Option<i64>,
    discard_until: i64,
    next_ts: Option<i64>,
    /// Linear gain applied to all output (Opus header output gain).
    gain: Option<f64>,
    /// Decoded but not yet returned samples (from priming).
    pending: Vec<f64>,
    scratch: Vec<f64>,
    eof: bool,
    consecutive_errors: u32,
    /// The decoder has produced output at least once (the Opus adapter trims pre-skip only then).
    decoded_any: bool,
    /// Opus pre-skip in output frames (what the adapter trims from its first packet).
    opus_pre_skip: u64,
    /// Output frame index of the next frame `next_frames` returns.
    pub(crate) position: u64,
    pub(crate) n_frames: Option<u64>,
}

fn map_err(e: SymError) -> DecodeError {
    match e {
        SymError::IoError(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            DecodeError::Decode("unexpected end of stream".into())
        }
        SymError::IoError(e) => DecodeError::Io(e),
        SymError::Unsupported(what) => DecodeError::Unsupported(what.to_string()),
        other => DecodeError::Decode(other.to_string()),
    }
}

impl Engine {
    pub(crate) fn open(
        mut source: Box<dyn ByteSource>,
        hint: Option<&str>,
    ) -> Result<(Self, DecodedInfo), DecodeError> {
        let hint_ext = hint.map(|h| h.trim_start_matches('.').to_ascii_lowercase());
        let mp4_timing = if source.is_seekable() {
            match gapless::scan_mp4(&mut *source) {
                Ok(t) => t,
                Err(e) => {
                    log::debug!("MP4 gapless scan failed: {e}");
                    source.rewind()?;
                    None
                }
            }
        } else {
            None
        };
        let byte_len = source.byte_len();

        let mss = MediaSourceStream::new(Box::new(ByteSourceMedia::new(source)), Default::default());
        let mut sym_hint = Hint::new();
        if let Some(ext) = &hint_ext {
            sym_hint.with_extension(ext);
        }
        let reader = registry::probe()
            .probe(&sym_hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| match e {
                SymError::Unsupported(_) => DecodeError::Unsupported("unrecognized container format".into()),
                other => map_err(other),
            })?;

        let track = reader
            .default_track(TrackType::Audio)
            .or_else(|| reader.first_track(TrackType::Audio))
            .cloned()
            .ok_or_else(|| DecodeError::Unsupported("no audio track".into()))?;
        let Some(CodecParameters::Audio(params)) = &track.codec_params else {
            return Err(DecodeError::Unsupported("no audio codec parameters".into()));
        };
        let codec = CodecKind::from_id(params.codec);
        let decoder = registry::codecs()
            .make_audio_decoder(params, &AudioDecoderOptions::default().gapless(true))
            .map_err(|e| match e {
                SymError::Unsupported(_) => DecodeError::Unsupported(format!(
                    "unsupported codec{}",
                    codec.name().map(|n| format!(" ({n})")).unwrap_or_default()
                )),
                other => map_err(other),
            })?;
        let codec_name =
            codec.name().map(str::to_owned).unwrap_or_else(|| decoder.codec_info().short_name.to_ascii_uppercase());
        let lossless = codec.lossless(params.codec);
        let bits = if lossless {
            params.bits_per_sample.or_else(|| match codec {
                CodecKind::Alac => params.extra_data.as_deref().and_then(alac_bit_depth),
                _ => None,
            })
        } else {
            None
        };
        let extra = params.extra_data.clone();
        let is_ogg = reader.format_info().format == FORMAT_ID_OGG;

        let mut engine = Engine {
            reader,
            decoder,
            track_id: track.id,
            time_base: track.time_base,
            sample_rate: params.sample_rate.unwrap_or(0),
            channels: params.channels.as_ref().map_or(0, |c| c.count()),
            layout: params
                .channels
                .as_ref()
                .map(ChannelLayout::from_symphonia)
                .unwrap_or_else(|| ChannelLayout::default_for(0)),
            codec,
            origin: 0,
            end_ts: None,
            discard_until: 0,
            next_ts: None,
            gain: None,
            pending: Vec::new(),
            scratch: Vec::new(),
            eof: false,
            consecutive_errors: 0,
            decoded_any: false,
            opus_pre_skip: 0,
            position: 0,
            n_frames: None,
        };

        if codec == CodecKind::Opus
            && let Some(extra) = extra.as_deref()
        {
            engine.gain = tags::opus_header_gain(extra);
            // The adapter scales the 48 kHz pre-skip to the decoder rate.
            let pre_skip = tags::opus_pre_skip(extra).unwrap_or(0);
            engine.opus_pre_skip = pre_skip * u64::from(engine.sample_rate) / 48_000;
            if is_ogg {
                // Ogg Opus timestamps (granule positions) include the pre-skip.
                engine.origin = tags::opus_pre_skip(extra).unwrap_or(0) as i64;
            }
        }

        // Prime: decode until the first non-empty buffer. This fixes the real output format
        // (sample rate / channel count are not always known from the container) and makes sure
        // broken input fails at open instead of in the middle of playback.
        engine.discard_until = engine.origin;
        let mut primed = Vec::new();
        loop {
            match engine.decode_step(&mut primed)? {
                Step::Frames(_) => break,
                Step::Continue => {}
                Step::Eof => {
                    if engine.sample_rate == 0 || engine.channels == 0 {
                        return Err(DecodeError::Decode("no decodable audio".into()));
                    }
                    break;
                }
            }
        }
        if engine.sample_rate == 0 || engine.channels == 0 {
            return Err(DecodeError::Decode("unknown sample rate or channel count".into()));
        }
        engine.pending = primed;
        if engine.pending.is_empty() && !engine.eof {
            return Err(DecodeError::Decode("no decodable audio".into()));
        }

        // Length and gapless window.
        let track_frames = track.num_frames.map(|n| engine.ts_to_frames(n as i64)).or_else(|| {
            track.duration.map(|d| engine.ts_to_frames(d.get().min(i64::MAX as u64) as i64))
        });
        let track_frames = track_frames.map(|f| f.max(0) as u64);
        if let Some(window) = mp4_timing.and_then(|t| t.window(engine.sample_rate, track_frames)) {
            // The window starts in raw decoder output; the priming buffer was decoded with
            // origin 0, so re-apply the window to it.
            engine.apply_window_to_pending(window);
        } else {
            engine.n_frames = track_frames.map(|f| f.saturating_sub(engine.origin as u64));
        }

        let mut gain_tags = GainTags::default();
        {
            let mut md = engine.reader.metadata();
            loop {
                if let Some(rev) = md.current() {
                    gain_tags.add_revision(rev);
                }
                if md.pop().is_none() {
                    break;
                }
            }
        }

        let duration_ms = engine.n_frames.map(|n| n * 1000 / u64::from(engine.sample_rate));
        let bitrate_kbps = match (byte_len, engine.n_frames) {
            (Some(bytes), Some(n)) if n > 0 => {
                let kbps = bytes as f64 * 8.0 * f64::from(engine.sample_rate) / n as f64 / 1000.0;
                (kbps.is_finite() && kbps < 1.0e6).then(|| kbps.round() as u32)
            }
            _ => None,
        };
        let info = DecodedInfo {
            format: SourceFormat {
                codec: codec_name,
                sample_rate: engine.sample_rate,
                bits_per_sample: bits,
                channels: engine.channels as u16,
                bitrate_kbps,
                lossless,
            },
            n_frames: engine.n_frames,
            duration_ms,
            tag_gain: gain_tags.finish(codec == CodecKind::Opus),
        };
        Ok((engine, info))
    }

    /// Re-trims the primed buffer for an MP4 window and sets up `origin` / `end_ts`.
    fn apply_window_to_pending(&mut self, w: Window) {
        let start = w.start as i64;
        self.origin = start;
        self.discard_until = start;
        self.end_ts = w.len.map(|l| start + l as i64);
        self.n_frames = w.len;
        // The primed samples are frames [0, pending_frames) of the raw timeline (MP4 starts at 0).
        let ch = self.channels;
        let pending_frames = (self.pending.len() / ch) as i64;
        let first_ts = self.next_ts.unwrap_or(pending_frames) - pending_frames;
        let lo = (start - first_ts).clamp(0, pending_frames) as usize;
        let hi = match self.end_ts {
            Some(e) => (e - first_ts).clamp(lo as i64, pending_frames) as usize,
            None => pending_frames as usize,
        };
        self.pending.truncate(hi * ch);
        self.pending.drain(..lo * ch);
        self.position = (first_ts + hi as i64 - start).max(0) as u64;
        if self.end_ts.is_some_and(|e| first_ts + pending_frames >= e) && hi < pending_frames as usize {
            self.eof = true;
        }
    }

    fn ts_to_frames(&self, ts: i64) -> i64 {
        match self.time_base {
            Some(tb) if !(tb.numer.get() == 1 && tb.denom.get() == self.sample_rate) && self.sample_rate > 0 => {
                let num = i128::from(ts) * i128::from(tb.numer.get()) * i128::from(self.sample_rate);
                let den = i128::from(tb.denom.get());
                let q = (num + den.signum() * den / 2).div_euclid(den);
                q.clamp(i64::MIN as i128, i64::MAX as i128) as i64
            }
            _ => ts,
        }
    }

    fn frames_to_ts(&self, frames: i64) -> i64 {
        match self.time_base {
            Some(tb) if !(tb.numer.get() == 1 && tb.denom.get() == self.sample_rate) && self.sample_rate > 0 => {
                let num = i128::from(frames) * i128::from(tb.denom.get());
                let den = i128::from(tb.numer.get()) * i128::from(self.sample_rate);
                num.div_euclid(den).clamp(i64::MIN as i128, i64::MAX as i128) as i64
            }
            _ => frames,
        }
    }

    fn dur_frames(&self, d: Duration) -> u64 {
        self.ts_to_frames(d.get().min(i64::MAX as u64) as i64).max(0) as u64
    }

    pub(crate) fn next_frames(&mut self, out: &mut Vec<f64>) -> Result<usize, DecodeError> {
        if !self.pending.is_empty() {
            let n = self.pending.len() / self.channels;
            out.extend_from_slice(&self.pending);
            self.pending.clear();
            return Ok(n);
        }
        loop {
            match self.decode_step(out)? {
                Step::Frames(n) => return Ok(n),
                Step::Continue => {}
                Step::Eof => return Ok(0),
            }
        }
    }

    fn next_packet(&mut self) -> Result<Option<Packet>, DecodeError> {
        loop {
            match self.reader.next_packet() {
                Ok(Some(p)) if p.track_id == self.track_id => {
                    return Ok(Some(p));
                }
                Ok(Some(_)) => continue,
                Ok(None) => return Ok(None),
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    log::warn!("stream ended unexpectedly (truncated input)");
                    return Ok(None);
                }
                Err(SymError::ResetRequired) => {
                    log::warn!("stream changed mid-way (chained stream); stopping");
                    return Ok(None);
                }
                Err(SymError::IoError(e)) => return Err(DecodeError::Io(e)),
                Err(e) => {
                    self.consecutive_errors += 1;
                    if self.consecutive_errors > MAX_CONSECUTIVE_ERRORS {
                        return Err(map_err(e));
                    }
                    log::warn!("demuxer error, skipping: {e}");
                }
            }
        }
    }

    fn decode_step(&mut self, out: &mut Vec<f64>) -> Result<Step, DecodeError> {
        if self.eof {
            return Ok(Step::Eof);
        }
        let Some(packet) = self.next_packet()? else {
            self.eof = true;
            return Ok(Step::Eof);
        };

        let trim_start = self.dur_frames(packet.trim_start);
        let trim_end = self.dur_frames(packet.trim_end);

        let first_decode = !self.decoded_any;
        let decoded = match self.decoder.decode(&packet) {
            Ok(buf) => {
                self.decoded_any = true;
                let n = buf.frames();
                let spec = buf.spec();
                let ch = spec.channels().count();
                if n == 0 {
                    None
                } else {
                    if self.sample_rate == 0 {
                        self.sample_rate = spec.rate();
                    }
                    if self.channels == 0 {
                        self.channels = ch;
                        self.layout = ChannelLayout::from_symphonia(spec.channels());
                    }
                    if ch != self.channels || spec.rate() != self.sample_rate {
                        return Err(DecodeError::Decode(format!(
                            "format changed mid-stream ({} ch / {} Hz)",
                            ch,
                            spec.rate()
                        )));
                    }
                    self.scratch.resize(n * ch, 0.0);
                    buf.copy_to_slice_interleaved(&mut self.scratch[..]);
                    Some(n)
                }
            }
            Err(SymError::DecodeError(msg)) => {
                self.consecutive_errors += 1;
                if self.consecutive_errors > MAX_CONSECUTIVE_ERRORS {
                    return Err(DecodeError::Decode(format!("too many corrupt packets: {msg}")));
                }
                log::warn!("skipping undecodable packet: {msg}");
                return Ok(self.conceal(&packet, out));
            }
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                // Some decoders report short packets as EOF reads.
                self.consecutive_errors += 1;
                if self.consecutive_errors > MAX_CONSECUTIVE_ERRORS {
                    return Err(DecodeError::Decode("too many truncated packets".into()));
                }
                log::warn!("skipping truncated packet");
                return Ok(self.conceal(&packet, out));
            }
            Err(e) => return Err(map_err(e)),
        };
        self.consecutive_errors = 0;
        let Some(n) = decoded else { return Ok(Step::Continue) };
        let n64 = n as u64;

        // symphonia's MP3 / Vorbis decoders and the libopus adapter apply the packet trims
        // themselves (the adapter also drops the Opus pre-skip on its very first packet); the
        // others (AAC, ALAC, FLAC, PCM, …) ignore them, so they are applied here. Packet `dur` is
        // not used: demuxers disagree on whether it already excludes the trims.
        let decoder_trims = matches!(self.codec, CodecKind::Mp3 | CodecKind::Mp2 | CodecKind::Mp1 | CodecKind::Vorbis | CodecKind::Opus);
        let (head, tail) = if decoder_trims { (0, 0) } else { (trim_start.min(n64), trim_end.min(n64 - trim_start.min(n64))) };
        let buf_start = match self.next_ts {
            Some(t) => t - head as i64,
            None => {
                let pts = self.ts_to_frames(packet.pts.get());
                if decoder_trims {
                    let pre_skip = if first_decode && self.codec == CodecKind::Opus { self.opus_pre_skip } else { 0 };
                    pts + (trim_start + pre_skip) as i64
                } else {
                    pts
                }
            }
        };
        let kept_lo = buf_start + head as i64;
        let kept_hi = buf_start + (n64 - tail) as i64;
        self.next_ts = Some(kept_hi);
        Ok(self.emit_range(buf_start, kept_lo, kept_hi, false, out))
    }

    /// Replaces an undecodable packet with silence to keep the timeline intact.
    fn conceal(&mut self, packet: &Packet, out: &mut Vec<f64>) -> Step {
        let (Some(t), true) = (self.next_ts, self.channels > 0) else { return Step::Continue };
        let max = u64::from(self.sample_rate) * MAX_CONCEAL_MS / 1000;
        let n = self.dur_frames(packet.dur).min(max);
        if n == 0 {
            return Step::Continue;
        }
        self.next_ts = Some(t + n as i64);
        self.emit_range(t, t, t + n as i64, true, out)
    }

    /// Emits the frames of the current scratch buffer (`buf_start` = timestamp of scratch frame 0)
    /// whose timestamps lie in `[lo, hi)` and inside the valid window.
    fn emit_range(&mut self, buf_start: i64, lo: i64, hi: i64, silence: bool, out: &mut Vec<f64>) -> Step {
        let lo = lo.max(self.discard_until).max(self.origin);
        let mut hi = hi;
        if let Some(end) = self.end_ts
            && hi >= end
        {
            hi = end;
            self.eof = true;
        }
        if hi <= lo {
            return if self.eof { Step::Eof } else { Step::Continue };
        }
        let ch = self.channels;
        let n = (hi - lo) as usize;
        let start = out.len();
        if silence {
            out.resize(start + n * ch, 0.0);
        } else {
            let a = (lo - buf_start) as usize * ch;
            out.extend_from_slice(&self.scratch[a..a + n * ch]);
        }
        if let Some(g) = self.gain {
            out[start..].iter_mut().for_each(|s| *s *= g);
        }
        self.position = (hi - self.origin) as u64;
        Step::Frames(n)
    }

    /// Output frame index of the next frame `next_frames` will return.
    pub(crate) fn returned_position(&self) -> u64 {
        let ch = self.channels.max(1);
        self.position.saturating_sub((self.pending.len() / ch) as u64)
    }

    /// Sample-accurate seek. Returns the output frame position reached.
    pub(crate) fn seek_frames(&mut self, target: u64) -> Result<u64, DecodeError> {
        let target = match self.n_frames {
            Some(n) => target.min(n),
            None => target,
        };
        let target_ts = self.origin + target as i64;
        let preroll = self.codec.preroll(self.sample_rate) as i64;
        let seek_frame_ts = (target_ts - preroll).max(0);
        let seek_ts = self.frames_to_ts(seek_frame_ts);

        if self.n_frames == Some(target) && target > 0 {
            self.pending.clear();
            self.eof = true;
            self.position = target;
            return Ok(target);
        }

        let res = self.reader.seek(
            SeekMode::Accurate,
            SeekTo::Timestamp { ts: Timestamp::new(seek_ts), track_id: self.track_id },
        );
        match res {
            Ok(_) => {
                self.decoder.reset();
                self.pending.clear();
                self.next_ts = None;
                self.eof = false;
                self.consecutive_errors = 0;
                self.discard_until = target_ts;
                self.position = target;
                Ok(target)
            }
            Err(SymError::SeekError(SeekErrorKind::OutOfRange)) => {
                self.pending.clear();
                self.eof = true;
                self.position = self.n_frames.unwrap_or(target);
                Ok(self.position)
            }
            Err(e) => {
                // Forward seek on a stream that cannot seek: decode and discard up to the target.
                let current = self.position;
                if target >= self.returned_position() {
                    let ch = self.channels.max(1);
                    let returned = current - (self.pending.len() / ch) as u64;
                    let drop_pending = (target.saturating_sub(returned) as usize).min(self.pending.len() / ch);
                    self.pending.drain(..drop_pending * ch);
                    self.discard_until = self.discard_until.max(target_ts);
                    if self.pending.is_empty() {
                        self.position = self.position.max(target);
                    }
                    log::debug!("seek failed ({e}); discarding forward to the target");
                    Ok(target)
                } else {
                    Err(DecodeError::Decode(format!("seek failed: {e}")))
                }
            }
        }
    }
}

/// Bit depth from an ALAC magic cookie (`ALACSpecificConfig`, optionally behind `frma` / `alac`
/// atom headers as in QuickTime sample descriptions).
fn alac_bit_depth(mut cookie: &[u8]) -> Option<u32> {
    for atom in [b"frma", b"alac"] {
        if cookie.len() >= 12 && &cookie[4..8] == atom {
            cookie = &cookie[12..];
        }
    }
    (cookie.len() >= 24).then(|| u32::from(cookie[5])).filter(|b| (8..=32).contains(b))
}

enum Step {
    Frames(usize),
    Continue,
    Eof,
}

/// Wraps an error for worker events.
pub(crate) fn arc(e: DecodeError) -> Arc<DecodeError> {
    Arc::new(e)
}

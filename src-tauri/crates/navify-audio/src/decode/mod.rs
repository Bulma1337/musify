//! Decoding (symphonia, + libopus behind the `opus` feature) and conversion to the engine format.
//!
//! Contract:
//! - `Decoder` yields interleaved f64 in the source's native rate and channel layout, with encoder
//!   delay/padding already trimmed (LAME/Xing, iTunSMPB, Opus pre-skip, FLAC/WAV exact), so that
//!   concatenating consecutive tracks is sample-accurate.
//! - `Conformer` converts to stereo at the device rate (ITU downmix for > 2 channels, dual mono for
//!   mono) with high-quality resampling (rubato, f64). It compensates the resampler delay: output
//!   length equals `round(input_frames * dst_rate / src_rate)` and the first output sample aligns with
//!   the first input sample. When rates match it passes samples through untouched (bit-exact).
//! - `TrackWorker` runs Decoder + Conformer on its own thread and fills an `rtrb` ring of f64 frames.
//!   Seeking is done by spawning a new worker at the target position (sources are cheap to reopen).
//! - Corrupt input must produce errors, never panics (workers catch panics and report them).
//!
//! # Gapless guarantees per format (see `decoder.rs` for the mechanics)
//!
//! - FLAC, WAV/AIFF/CAF PCM, ALAC (MP4): exact; decoded samples are bit-identical to the source
//!   (integer PCM is converted exactly, `x / 2^(bits-1)`).
//! - MP3: exact length when the file has a LAME/Xing header (encoder delay + 529 decoder delay and
//!   the padding are removed). Without it, delay/padding are unknown and kept.
//! - AAC in MP4/M4A: exact length from the `elst` edit list (ffmpeg, Apple) or iTunSMPB (iTunes),
//!   both parsed here because symphonia ignores them. Raw ADTS `.aac` has no gapless information.
//! - Ogg Vorbis, Ogg Opus: exact length from granule positions and the Opus pre-skip.
//! - Opus / Vorbis in Matroska/WebM: start trimmed (CodecDelay / pre-skip), end padding not
//!   trimmed; timestamps have millisecond resolution there.
//!
//! Seeking is sample-accurate on the same timeline: lossless formats seek bit-exactly; lossy formats
//! decode a codec-specific pre-roll (MP3 2 frames, AAC 2048, Vorbis 8192, Opus 400 ms) and discard
//! up to the exact target frame. MP3 and Vorbis then match a full decode bit-exactly, Opus to
//! < −115 dBFS; AAC differs only in noise-substituted (PNS) bands, whose random generator is not
//! part of the stream.

use std::sync::Arc;

use crossbeam_channel::Sender;

use crate::api::{ReplayGainInfo, SourceFormat, TrackId};
use crate::source::{ByteSource, OpenedSource, SourceError};

mod channel_map;
mod decoder;
mod gapless;
mod media_source;
mod registry;
mod resample;
mod tags;
mod worker;

pub use channel_map::{ChannelLayout, MINUS_3DB, Speaker, StereoMix};
pub use registry::opus_supported;
pub use resample::{MIN_FILTER_LEN, ResamplerKind};

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("unsupported format: {0}")]
    Unsupported(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("source error: {0}")]
    Source(#[from] SourceError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedInfo {
    pub format: SourceFormat,
    /// Exact length in frames after gapless trimming, if known.
    pub n_frames: Option<u64>,
    pub duration_ms: Option<u64>,
    /// ReplayGain / R128 values found in the file's tags.
    pub tag_gain: Option<ReplayGainInfo>,
}

pub struct Decoder {
    info: DecodedInfo,
    engine: decoder::Engine,
    /// Set after a panic inside symphonia; every later call fails.
    poisoned: bool,
}

/// Runs symphonia code, turning panics on malformed input into errors.
fn guarded<T>(f: impl FnOnce() -> Result<T, DecodeError>) -> Result<T, DecodeError> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            log::error!("decoder panicked on malformed input: {msg}");
            Err(DecodeError::Decode(format!("decoder panicked: {msg}")))
        }
    }
}

impl Decoder {
    /// Probes and opens a source. `hint` is a file extension such as "flac" or "mp3".
    ///
    /// Opening decodes the first packet, so unreadable input fails here rather than mid-playback.
    pub fn open(source: Box<dyn ByteSource>, hint: Option<&str>) -> Result<Self, DecodeError> {
        let (engine, info) = guarded(|| decoder::Engine::open(source, hint))?;
        Ok(Self { info, engine, poisoned: false })
    }

    pub fn info(&self) -> &DecodedInfo {
        &self.info
    }

    /// Native sample rate of the decoded output.
    pub fn sample_rate(&self) -> u32 {
        self.engine.sample_rate
    }

    /// Channel count of the decoded output.
    pub fn channels(&self) -> usize {
        self.engine.channels
    }

    /// Channel order of the decoded output (for the conformer's down-mix).
    pub fn channel_layout(&self) -> &ChannelLayout {
        &self.engine.layout
    }

    /// Frame index (native rate, after gapless trimming) of the next frame `next_frames` returns.
    pub fn position_frames(&self) -> u64 {
        self.engine.returned_position()
    }

    /// Seeks to `position_ms` (sample-accurate where the format allows). Returns the actual position.
    pub fn seek(&mut self, position_ms: u64) -> Result<u64, DecodeError> {
        let sr = u64::from(self.engine.sample_rate);
        let frames = (u128::from(position_ms) * u128::from(sr) / 1000) as u64;
        let reached = self.seek_frames(frames)?;
        Ok((u128::from(reached) * 1000 / u128::from(sr.max(1))) as u64)
    }

    /// Seeks to an exact frame index (native rate). Returns the frame reached.
    pub fn seek_frames(&mut self, frame: u64) -> Result<u64, DecodeError> {
        self.check_poisoned()?;
        let r = guarded(|| self.engine.seek_frames(frame));
        self.poison_on_panic(r)
    }

    fn check_poisoned(&self) -> Result<(), DecodeError> {
        if self.poisoned { Err(DecodeError::Decode("decoder failed earlier".into())) } else { Ok(()) }
    }

    fn poison_on_panic<T>(&mut self, r: Result<T, DecodeError>) -> Result<T, DecodeError> {
        if let Err(DecodeError::Decode(msg)) = &r
            && msg.starts_with("decoder panicked")
        {
            self.poisoned = true;
        }
        r
    }

    /// Decodes the next packet and appends its interleaved samples to `out`.
    /// Returns the number of frames appended; `Ok(0)` means end of stream.
    pub fn next_frames(&mut self, out: &mut Vec<f64>) -> Result<usize, DecodeError> {
        self.check_poisoned()?;
        let len = out.len();
        let r = guarded(|| self.engine.next_frames(out));
        if r.is_err() {
            out.truncate(len);
        }
        self.poison_on_panic(r)
    }
}

/// Converts native-format audio to interleaved stereo f64 at the device rate.
pub struct Conformer {
    src_rate: u32,
    dst_rate: u32,
    channels: usize,
    mix: StereoMix,
    resampler: Option<resample::StereoResampler>,
}

impl Conformer {
    /// Assumes the conventional channel order for `src_channels` (see [`ChannelLayout::default_for`]).
    pub fn new(src_rate: u32, src_channels: usize, dst_rate: u32) -> Self {
        Self::with_layout(src_rate, &ChannelLayout::default_for(src_channels), dst_rate)
    }

    /// Uses the decoder's actual channel order ([`Decoder::channel_layout`]).
    pub fn with_layout(src_rate: u32, layout: &ChannelLayout, dst_rate: u32) -> Self {
        let resampler = (src_rate != dst_rate && src_rate > 0 && dst_rate > 0)
            .then(|| resample::StereoResampler::new(src_rate, dst_rate));
        Self { src_rate, dst_rate, channels: layout.channels(), mix: layout.stereo_mix(), resampler }
    }

    pub fn src_rate(&self) -> u32 {
        self.src_rate
    }

    pub fn dst_rate(&self) -> u32 {
        self.dst_rate
    }

    /// The resampler in use (`None` = same rate, samples pass through).
    pub fn resampler_kind(&self) -> Option<ResamplerKind> {
        self.resampler.as_ref().map(|r| r.kind())
    }

    /// Converts `input` (interleaved, source layout) and appends stereo frames to `out`.
    /// `input` must contain whole frames; a trailing partial frame is ignored.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        let ch = self.channels;
        if ch == 0 {
            return;
        }
        let input = &input[..input.len() / ch * ch];
        match &mut self.resampler {
            None => match &self.mix {
                StereoMix::Passthrough => out.extend_from_slice(input),
                StereoMix::DualMono => {
                    out.reserve(input.len() * 2);
                    for &s in input {
                        out.push(s);
                        out.push(s);
                    }
                }
                StereoMix::Matrix(m) => {
                    out.reserve(input.len() / ch * 2);
                    for frame in input.chunks_exact(ch) {
                        let (l, r) = mix_frame(frame, m);
                        out.push(l);
                        out.push(r);
                    }
                }
            },
            Some(rs) => {
                match &self.mix {
                    StereoMix::Passthrough => {
                        for [l, r] in input.as_chunks::<2>().0 {
                            rs.push_frame(*l, *r);
                        }
                    }
                    StereoMix::DualMono => {
                        for &s in input {
                            rs.push_frame(s, s);
                        }
                    }
                    StereoMix::Matrix(m) => {
                        for frame in input.chunks_exact(ch) {
                            let (l, r) = mix_frame(frame, m);
                            rs.push_frame(l, r);
                        }
                    }
                }
                rs.run(out);
            }
        }
    }

    /// End of stream: appends the remaining delayed samples. The conformer can be reused for a new
    /// stream afterwards.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        if let Some(rs) = &mut self.resampler {
            rs.flush(out);
        }
    }

    /// Drops buffered samples and filter state (e.g. after a decoder seek).
    pub fn reset(&mut self) {
        if let Some(rs) = &mut self.resampler {
            rs.reset();
        }
    }
}

#[inline]
fn mix_frame(frame: &[f64], m: &[(f64, f64)]) -> (f64, f64) {
    let mut l = 0.0;
    let mut r = 0.0;
    for (s, g) in frame.iter().zip(m) {
        l += s * g.0;
        r += s * g.1;
    }
    (l, r)
}

#[derive(Clone, Debug)]
pub struct TrackWorkerConfig {
    /// Device sample rate the worker converts to.
    pub dst_rate: u32,
    /// Ring capacity in frames (≈ 2 s).
    pub ring_frames: usize,
    /// Position to start at; the worker seeks the decoder there (or the source already starts there).
    pub start_ms: u64,
}

#[derive(Debug)]
pub enum WorkerEvent {
    /// Opened and decoding; `start_frame` is the absolute frame (device rate) of the first ring sample.
    Ready { id: TrackId, info: DecodedInfo, start_frame: u64 },
    /// All frames were pushed; `end_frame` is the absolute frame (device rate) after the last sample.
    Finished { id: TrackId, end_frame: u64 },
    Error { id: TrackId, error: Arc<DecodeError> },
}

/// Handle to a decoding thread for one track. Dropping it stops the thread.
pub struct TrackWorker {
    id: TrackId,
    control: Arc<worker::Control>,
}

impl TrackWorker {
    /// Spawns a worker. `open` is called on the worker thread (it may block on the network).
    /// Returns the handle and the consumer side of the f64 stereo ring.
    pub fn spawn(
        id: TrackId,
        open: Box<dyn FnOnce() -> Result<OpenedSource, SourceError> + Send>,
        hint: Option<String>,
        config: TrackWorkerConfig,
        events: Sender<WorkerEvent>,
    ) -> (Self, rtrb::Consumer<f64>) {
        let (control, consumer) = worker::spawn(id.clone(), open, hint, config, events);
        (Self { id, control }, consumer)
    }

    pub fn id(&self) -> &TrackId {
        &self.id
    }

    /// True while the worker thread is alive.
    pub fn is_running(&self) -> bool {
        self.control.is_running()
    }
}

impl Drop for TrackWorker {
    fn drop(&mut self) {
        // Never joins: the thread notices the flag within one wait interval (or as soon as `open`
        // returns) and exits on its own.
        self.control.stop();
    }
}

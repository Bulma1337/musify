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

use std::sync::Arc;

use crossbeam_channel::Sender;

use crate::api::{ReplayGainInfo, SourceFormat, TrackId};
use crate::source::{ByteSource, OpenedSource, SourceError};

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
}

impl Decoder {
    /// Probes and opens a source. `hint` is a file extension such as "flac" or "mp3".
    pub fn open(source: Box<dyn ByteSource>, hint: Option<&str>) -> Result<Self, DecodeError> {
        let _ = (source, hint);
        todo!("decode: Decoder::open")
    }

    pub fn info(&self) -> &DecodedInfo {
        &self.info
    }

    /// Seeks to `position_ms` (sample-accurate where the format allows). Returns the actual position.
    pub fn seek(&mut self, position_ms: u64) -> Result<u64, DecodeError> {
        let _ = position_ms;
        todo!("decode: seek")
    }

    /// Decodes the next packet and appends its interleaved samples to `out`.
    /// Returns the number of frames appended; `Ok(0)` means end of stream.
    pub fn next_frames(&mut self, out: &mut Vec<f64>) -> Result<usize, DecodeError> {
        let _ = out;
        todo!("decode: next_frames")
    }
}

/// Converts native-format audio to interleaved stereo f64 at the device rate.
pub struct Conformer {
    src_rate: u32,
    dst_rate: u32,
}

impl Conformer {
    pub fn new(src_rate: u32, src_channels: usize, dst_rate: u32) -> Self {
        let _ = (src_rate, src_channels, dst_rate);
        todo!("decode: Conformer::new")
    }

    /// Converts `input` (interleaved, source layout) and appends stereo frames to `out`.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        let _ = (input, out);
        todo!("decode: Conformer::process")
    }

    /// End of stream: appends the remaining delayed samples.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        let _ = out;
        todo!("decode: Conformer::flush")
    }
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
        let _ = (id, open, hint, config, events);
        todo!("decode: TrackWorker::spawn")
    }

    pub fn id(&self) -> &TrackId {
        &self.id
    }
}

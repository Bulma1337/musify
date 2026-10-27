//! Cast v2 wire format: `CastMessage` protobuf (hand-written, string payloads only) behind a 4-byte
//! big-endian length prefix, and a channel over any byte stream (TLS in the app, plain TCP in tests).

use std::io::{Read, Write};

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

/// Largest frame accepted from a device.
pub const MAX_FRAME: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum CastError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid message: {0}")]
    Invalid(String),
    #[error("frame too large: {0} bytes")]
    TooLarge(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CastMessage {
    pub source_id: String,
    pub destination_id: String,
    pub namespace: String,
    /// JSON text (`payload_utf8`).
    pub payload: String,
}

/// Protobuf encoding of `msg` (protocol version CASTV2_1_0, payload type STRING), without the prefix.
pub fn encode_message(_msg: &CastMessage) -> Vec<u8> {
    todo!("castv2::encode_message")
}

/// Decodes a protobuf `CastMessage`; unknown fields are skipped, binary payloads are an error.
pub fn decode_message(_bytes: &[u8]) -> Result<CastMessage, CastError> {
    todo!("castv2::decode_message")
}

/// Length prefix plus [`encode_message`].
pub fn frame(_msg: &CastMessage) -> Vec<u8> {
    todo!("castv2::frame")
}

/// Collects bytes until whole frames are available.
#[derive(Debug, Default)]
pub struct FrameReader {
    _buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, _data: &[u8]) {
        todo!()
    }

    /// The next complete message, `Ok(None)` while incomplete, an error for frames over [`MAX_FRAME`].
    pub fn next_message(&mut self) -> Result<Option<CastMessage>, CastError> {
        todo!()
    }
}

/// A Cast connection over `S` (the stream should have a short read timeout so `poll` returns).
pub struct CastChannel<S: Read + Write> {
    _stream: S,
    _reader: FrameReader,
}

impl<S: Read + Write> CastChannel<S> {
    pub fn new(_stream: S) -> Self {
        todo!()
    }

    pub fn send(&mut self, _msg: &CastMessage) -> Result<(), CastError> {
        todo!()
    }

    /// Reads what is available (a read timeout or `WouldBlock` counts as "nothing yet") and returns
    /// the next complete message if there is one.
    pub fn poll(&mut self) -> Result<Option<CastMessage>, CastError> {
        todo!()
    }
}

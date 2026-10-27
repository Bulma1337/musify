//! Cast v2 wire format: `CastMessage` protobuf (hand-written, string payloads only) behind a 4-byte
//! big-endian length prefix, and a channel over any byte stream (TLS in the app, plain TCP in tests).

use std::io::{self, Read, Write};

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

/// Largest frame accepted from a device.
pub const MAX_FRAME: usize = 64 * 1024;

/// Protobuf wire types.
const WIRE_VARINT: u8 = 0;
const WIRE_FIXED64: u8 = 1;
const WIRE_LEN: u8 = 2;
const WIRE_FIXED32: u8 = 5;
/// `CastMessage.PayloadType.BINARY`.
const PAYLOAD_BINARY: u64 = 1;

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

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_string(out: &mut Vec<u8>, field: u8, text: &str) {
    out.push((field << 3) | WIRE_LEN);
    put_varint(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

/// Protobuf encoding of `msg` (protocol version CASTV2_1_0, payload type STRING), without the prefix.
pub fn encode_message(msg: &CastMessage) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        16 + msg.source_id.len()
            + msg.destination_id.len()
            + msg.namespace.len()
            + msg.payload.len(),
    );
    out.extend_from_slice(&[1 << 3, 0]);
    put_string(&mut out, 2, &msg.source_id);
    put_string(&mut out, 3, &msg.destination_id);
    put_string(&mut out, 4, &msg.namespace);
    out.extend_from_slice(&[5 << 3, 0]);
    put_string(&mut out, 6, &msg.payload);
    out
}

struct Cursor<'a> {
    buf: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn varint(&mut self) -> Result<u64, CastError> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let (&byte, rest) = self.buf.split_first().ok_or_else(truncated)?;
            self.buf = rest;
            value |= u64::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(CastError::Invalid("varint too long".into()))
    }

    fn take(&mut self, len: u64) -> Result<&'a [u8], CastError> {
        let len = usize::try_from(len)
            .ok()
            .filter(|&n| n <= self.buf.len())
            .ok_or_else(truncated)?;
        let (head, rest) = self.buf.split_at(len);
        self.buf = rest;
        Ok(head)
    }

    fn string(&mut self) -> Result<String, CastError> {
        let len = self.varint()?;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|_| CastError::Invalid("text is not UTF-8".into()))
    }
}

fn truncated() -> CastError {
    CastError::Invalid("truncated message".into())
}

/// Decodes a protobuf `CastMessage`; unknown fields are skipped, binary payloads are an error.
pub fn decode_message(bytes: &[u8]) -> Result<CastMessage, CastError> {
    let mut cursor = Cursor { buf: bytes };
    let mut msg = CastMessage {
        source_id: String::new(),
        destination_id: String::new(),
        namespace: String::new(),
        payload: String::new(),
    };
    let mut binary = false;
    while !cursor.buf.is_empty() {
        let tag = cursor.varint()?;
        let wire = (tag & 7) as u8;
        match (tag >> 3, wire) {
            (2, WIRE_LEN) => msg.source_id = cursor.string()?,
            (3, WIRE_LEN) => msg.destination_id = cursor.string()?,
            (4, WIRE_LEN) => msg.namespace = cursor.string()?,
            (6, WIRE_LEN) => msg.payload = cursor.string()?,
            (5, WIRE_VARINT) => binary |= cursor.varint()? == PAYLOAD_BINARY,
            (7, WIRE_LEN) => {
                let len = cursor.varint()?;
                cursor.take(len)?;
                binary = true;
            }
            (_, WIRE_VARINT) => {
                cursor.varint()?;
            }
            (_, WIRE_FIXED64) => {
                cursor.take(8)?;
            }
            (_, WIRE_LEN) => {
                let len = cursor.varint()?;
                cursor.take(len)?;
            }
            (_, WIRE_FIXED32) => {
                cursor.take(4)?;
            }
            _ => return Err(CastError::Invalid(format!("unsupported wire type {wire}"))),
        }
    }
    if binary {
        return Err(CastError::Invalid("binary payload".into()));
    }
    Ok(msg)
}

/// Length prefix plus [`encode_message`].
pub fn frame(msg: &CastMessage) -> Vec<u8> {
    let body = encode_message(msg);
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// Collects bytes until whole frames are available.
#[derive(Debug, Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// The next complete message, `Ok(None)` while incomplete, an error for frames over [`MAX_FRAME`].
    ///
    /// A frame that doesn't decode is dropped and reported; the frames behind it stay readable.
    pub fn next_message(&mut self) -> Result<Option<CastMessage>, CastError> {
        let Some(prefix) = self.buf.first_chunk::<4>() else {
            return Ok(None);
        };
        let len = u32::from_be_bytes(*prefix) as usize;
        if len > MAX_FRAME {
            return Err(CastError::TooLarge(len));
        }
        let end = 4 + len;
        if self.buf.len() < end {
            return Ok(None);
        }
        let decoded = decode_message(&self.buf[4..end]);
        self.buf.drain(..end);
        decoded.map(Some)
    }
}

/// A Cast connection over `S` (the stream should have a short read timeout so `poll` returns).
pub struct CastChannel<S: Read + Write> {
    stream: S,
    reader: FrameReader,
}

impl<S: Read + Write> CastChannel<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            reader: FrameReader::default(),
        }
    }

    pub fn send(&mut self, msg: &CastMessage) -> Result<(), CastError> {
        self.stream.write_all(&frame(msg))?;
        self.stream.flush()?;
        Ok(())
    }

    /// Reads what is available (a read timeout or `WouldBlock` counts as "nothing yet") and returns
    /// the next complete message if there is one.
    pub fn poll(&mut self) -> Result<Option<CastMessage>, CastError> {
        if let Some(msg) = self.reader.next_message()? {
            return Ok(Some(msg));
        }
        let mut chunk = [0u8; 4096];
        match self.stream.read(&mut chunk) {
            Ok(0) => Err(io::Error::from(io::ErrorKind::UnexpectedEof).into()),
            Ok(n) => {
                self.reader.push(&chunk[..n]);
                self.reader.next_message()
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn sample() -> CastMessage {
        CastMessage {
            source_id: "sender-0".into(),
            destination_id: "receiver-0".into(),
            namespace: NS_CONNECTION.into(),
            payload: r#"{"type":"CONNECT"}"#.into(),
        }
    }

    fn golden() -> Vec<u8> {
        let mut out = vec![0x08, 0x00, 0x12, 8];
        out.extend_from_slice(b"sender-0");
        out.extend_from_slice(&[0x1A, 10]);
        out.extend_from_slice(b"receiver-0");
        out.extend_from_slice(&[0x22, 40]);
        out.extend_from_slice(NS_CONNECTION.as_bytes());
        out.extend_from_slice(&[0x28, 0x00, 0x32, 18]);
        out.extend_from_slice(br#"{"type":"CONNECT"}"#);
        out
    }

    #[test]
    fn encodes_the_golden_bytes() {
        assert_eq!(NS_CONNECTION.len(), 40);
        assert_eq!(encode_message(&sample()), golden());
        let framed = frame(&sample());
        assert_eq!(&framed[..4], &(golden().len() as u32).to_be_bytes());
        assert_eq!(&framed[4..], golden().as_slice());
    }

    #[test]
    fn round_trips_including_long_payloads() {
        assert_eq!(decode_message(&golden()).unwrap(), sample());
        let mut long = sample();
        long.payload = format!(r#"{{"text":"{}"}}"#, "ä".repeat(5000));
        assert_eq!(decode_message(&encode_message(&long)).unwrap(), long);
        let empty = CastMessage {
            source_id: String::new(),
            destination_id: String::new(),
            namespace: String::new(),
            payload: String::new(),
        };
        assert_eq!(decode_message(&encode_message(&empty)).unwrap(), empty);
    }

    #[test]
    fn decodes_fields_in_any_order_and_skips_unknown_ones() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x32, 2, b'{', b'}']);
        bytes.extend_from_slice(&[0x40, 0xAC, 0x02]); // field 8, varint
        bytes.extend_from_slice(&[0x49, 1, 2, 3, 4, 5, 6, 7, 8]); // field 9, fixed64
        bytes.extend_from_slice(&[0x52, 3, 9, 9, 9]); // field 10, length-delimited
        bytes.extend_from_slice(&[0x5D, 1, 2, 3, 4]); // field 11, fixed32
        bytes.extend_from_slice(&[0x22, 2, b'n', b's']);
        bytes.extend_from_slice(&[0x1A, 1, b'd', 0x12, 1, b's', 0x28, 0, 0x08, 0]);
        let msg = decode_message(&bytes).unwrap();
        assert_eq!(
            msg,
            CastMessage {
                source_id: "s".into(),
                destination_id: "d".into(),
                namespace: "ns".into(),
                payload: "{}".into(),
            }
        );
    }

    #[test]
    fn rejects_bad_input() {
        let golden = golden();
        for len in 1..golden.len() {
            // Cutting inside a field is an error; cutting between fields yields a partial message.
            let _ = decode_message(&golden[..len]);
        }
        assert!(matches!(
            decode_message(&golden[..golden.len() - 1]),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x12, 2, 0xFF, 0xFE]),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x28, 1, 0x32, 1, b'x']),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x3A, 2, 1, 2]),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x13]),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x80; 11]),
            Err(CastError::Invalid(_))
        ));
        assert!(matches!(
            decode_message(&[0x12, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]),
            Err(CastError::Invalid(_))
        ));
    }

    #[test]
    fn frame_reader_handles_byte_by_byte_pushes() {
        let mut bytes = frame(&sample());
        bytes.extend_from_slice(&frame(&CastMessage {
            payload: r#"{"type":"PING"}"#.into(),
            ..sample()
        }));
        let mut reader = FrameReader::default();
        let mut got = Vec::new();
        for byte in bytes {
            reader.push(&[byte]);
            while let Some(msg) = reader.next_message().unwrap() {
                got.push(msg);
            }
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], sample());
        assert_eq!(got[1].payload, r#"{"type":"PING"}"#);
        assert!(reader.next_message().unwrap().is_none());
    }

    #[test]
    fn oversize_frames_fail_before_they_are_buffered() {
        let mut reader = FrameReader::default();
        reader.push(&((MAX_FRAME as u32 + 1).to_be_bytes()));
        assert!(matches!(reader.next_message(), Err(CastError::TooLarge(n)) if n == MAX_FRAME + 1));

        let mut at_limit = FrameReader::default();
        at_limit.push(&(MAX_FRAME as u32).to_be_bytes());
        assert!(at_limit.next_message().unwrap().is_none());
    }

    #[test]
    fn a_broken_frame_does_not_block_the_next_one() {
        let mut reader = FrameReader::default();
        reader.push(&[0, 0, 0, 2, 0x12, 0x05]);
        reader.push(&frame(&sample()));
        assert!(matches!(reader.next_message(), Err(CastError::Invalid(_))));
        assert_eq!(reader.next_message().unwrap().unwrap(), sample());
    }

    /// Hands out scripted read results, collects writes.
    struct Scripted {
        reads: VecDeque<io::Result<Vec<u8>>>,
        written: Vec<u8>,
    }

    impl Read for Scripted {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.reads.pop_front() {
                Some(Ok(data)) => {
                    buf[..data.len()].copy_from_slice(&data);
                    Ok(data.len())
                }
                Some(Err(e)) => Err(e),
                None => Ok(0),
            }
        }
    }

    impl Write for Scripted {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn channel_polls_timeouts_buffered_frames_and_eof() {
        let two = [frame(&sample()), frame(&sample())].concat();
        let (first, second) = two.split_at(10);
        let mut channel = CastChannel::new(Scripted {
            reads: VecDeque::from([
                Err(io::ErrorKind::TimedOut.into()),
                Ok(first.to_vec()),
                Err(io::ErrorKind::WouldBlock.into()),
                Ok(second.to_vec()),
            ]),
            written: Vec::new(),
        });
        assert!(channel.poll().unwrap().is_none());
        assert!(channel.poll().unwrap().is_none());
        assert!(channel.poll().unwrap().is_none());
        assert_eq!(channel.poll().unwrap().unwrap(), sample());
        // The second frame is already buffered: no read needed.
        assert_eq!(channel.poll().unwrap().unwrap(), sample());
        match channel.poll() {
            Err(CastError::Io(e)) => assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof),
            other => panic!("expected EOF, got {other:?}"),
        }
    }

    #[test]
    fn channel_send_writes_a_frame() {
        let mut channel = CastChannel::new(Scripted {
            reads: VecDeque::new(),
            written: Vec::new(),
        });
        channel.send(&sample()).unwrap();
        assert_eq!(channel.stream.written, frame(&sample()));
    }
}

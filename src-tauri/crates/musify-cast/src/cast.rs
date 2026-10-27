//! Cast v2 renderer: launches the default media receiver and controls it over the media namespace.

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::gate::NetGate;
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus};

/// App id of the default media receiver.
pub const DEFAULT_MEDIA_RECEIVER: &str = "CC1AD845";

/// What the default media receiver plays (FLAC up to 96 kHz).
pub const CAST_AUDIO_MIMES: &[&str] = &[
    "audio/flac",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/wav",
];
pub const CAST_MAX_SAMPLE_RATE: u32 = 96_000;

pub struct CastRenderer<S: Read + Write + Send> {
    _stream: std::marker::PhantomData<S>,
}

/// The TLS stream the app uses.
pub type CastTlsStream = rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>;

impl CastRenderer<CastTlsStream> {
    /// Connects through `gate` (TCP + TLS; Cast devices use self-signed certificates), opens the
    /// virtual connection, launches the default media receiver (or joins it if it already runs) and
    /// connects to its transport.
    pub fn connect(_gate: Arc<NetGate>, _addr: SocketAddr) -> Result<Self, RendererError> {
        todo!("CastRenderer::connect")
    }
}

impl<S: Read + Write + Send> CastRenderer<S> {
    /// Same as `connect`, over an already open stream (tests use plain TCP on localhost).
    pub fn over_stream(_gate: Arc<NetGate>, _stream: S) -> Result<Self, RendererError> {
        todo!("CastRenderer::over_stream")
    }
}

impl<S: Read + Write + Send> Renderer for CastRenderer<S> {
    fn supported_mimes(&self) -> Vec<String> {
        CAST_AUDIO_MIMES.iter().map(|m| m.to_string()).collect()
    }

    fn max_sample_rate(&self) -> Option<u32> {
        Some(CAST_MAX_SAMPLE_RATE)
    }

    fn load(&mut self, _item: &MediaItem, _start_ms: u64, _play: bool) -> Result<(), RendererError> {
        todo!()
    }

    fn set_next(&mut self, _item: Option<&MediaItem>) -> Result<(), RendererError> {
        Err(RendererError::Unsupported)
    }

    fn play(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn pause(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn stop(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn seek(&mut self, _position_ms: u64) -> Result<(), RendererError> {
        todo!()
    }

    fn set_volume(&mut self, _volume: f64) -> Result<(), RendererError> {
        todo!()
    }

    fn status(&mut self) -> Result<RendererStatus, RendererError> {
        todo!()
    }

    fn close(&mut self) {}
}

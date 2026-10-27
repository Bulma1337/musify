//! The interface every network renderer implements (UPnP/DLNA in `dlna`, Cast in `cast`), and the
//! devices discovery finds.
//!
//! The session (`session.rs`) owns one renderer on its own thread and calls these methods one at a
//! time; implementations may block for a few seconds (network round trips) but never indefinitely.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde::Serialize;

use crate::upnp::DeviceDescription;

/// How a device is controlled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    /// UPnP AV / DLNA MediaRenderer (TVs, AV receivers, many streamers and multiroom speakers).
    Upnp,
    /// Cast v2 with the default media receiver.
    Cast,
}

/// What the device is, for its icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    Speaker,
    Tv,
    /// Several speakers playing together.
    Group,
}

/// A renderer found on the network, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDevice {
    /// Stable id: `upnp:<UDN>` or `cast:<device id>`.
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub kind: DeviceKind,
    /// Model name as the device reports it, if any.
    pub model: Option<String>,
}

/// How to reach a found device (stays in Rust).
#[derive(Clone, Debug)]
pub enum DeviceAddress {
    Upnp(Box<DeviceDescription>),
    Cast(SocketAddr),
}

#[derive(Clone, Debug)]
pub struct FoundDevice {
    pub device: NetworkDevice,
    pub address: DeviceAddress,
    /// The device's IP: the only address allowed to fetch from the LAN proxy during a session.
    pub ip: IpAddr,
}

/// One track as the renderer gets it.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaItem {
    /// URL the renderer fetches: Musify's LAN proxy with a secret token. Never log it.
    pub url: String,
    /// MIME type of the stream, e.g. `audio/flac`.
    pub mime: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Cover through the LAN proxy (secret token as well), if there is one.
    pub cover_url: Option<String>,
    pub duration_ms: Option<u64>,
    /// Byte ranges work (original file). False for server transcodes.
    pub seekable: bool,
}

/// Transport state as the renderer reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportState {
    Playing,
    Paused,
    /// Loading or rebuffering.
    Buffering,
    /// Stopped (by us or by the device) or nothing loaded; not known to have finished.
    Stopped,
    /// The item played to its end (Cast `IDLE`/`FINISHED`).
    Finished,
    /// The item could not be played (Cast `IDLE`/`ERROR`, DLNA `ERROR_OCCURRED`).
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RendererStatus {
    pub state: TransportState,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    /// URL of the item the renderer has loaded, if it reports one (DLNA `TrackURI`, Cast `contentId`).
    pub current_url: Option<String>,
    /// Device volume 0.0…1.0, if reported.
    pub volume: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum RendererError {
    /// The device can't be reached any more (refused, reset, timed out, TLS closed).
    #[error("connection lost: {0}")]
    Connection(String),
    /// The device answered but refused the request (SOAP fault, LOAD_FAILED, …).
    #[error("{0}")]
    Rejected(String),
    /// The device doesn't support this action (e.g. no SetNextAVTransportURI).
    #[error("not supported by the device")]
    Unsupported,
    /// Another app took over the device (Cast receiver app replaced or stopped).
    #[error("another app took over the device")]
    TakenOver,
}

/// A connected renderer. All methods are called from the session thread, one at a time.
pub trait Renderer: Send {
    /// Audio MIME types the device accepts (lowercase), e.g. `audio/flac`. Empty = unknown.
    fn supported_mimes(&self) -> Vec<String>;

    /// Highest sample rate the device plays, if it is known to be limited.
    fn max_sample_rate(&self) -> Option<u32> {
        None
    }

    /// Replaces whatever is loaded with `item`, starting at `start_ms`. With `play == false` the device
    /// must stay silent; it may defer the seek to `start_ms` until [`Renderer::play`].
    fn load(&mut self, item: &MediaItem, start_ms: u64, play: bool) -> Result<(), RendererError>;

    /// Hands the device the item after the current one, so it can move on by itself (gapless where
    /// supported). `None` clears it. Returns [`RendererError::Unsupported`] if the device can't.
    fn set_next(&mut self, item: Option<&MediaItem>) -> Result<(), RendererError>;

    fn play(&mut self) -> Result<(), RendererError>;
    fn pause(&mut self) -> Result<(), RendererError>;
    fn stop(&mut self) -> Result<(), RendererError>;
    fn seek(&mut self, position_ms: u64) -> Result<(), RendererError>;

    /// Device volume 0.0…1.0 (linear, as the device's own volume control).
    fn set_volume(&mut self, volume: f64) -> Result<(), RendererError>;

    /// Current state; called about once a second while a track is loaded.
    fn status(&mut self) -> Result<RendererStatus, RendererError>;

    /// Called every session tick (~250 ms): keep the connection alive (heartbeats), read pushed
    /// messages. Must return quickly.
    fn tick(&mut self) -> Result<(), RendererError> {
        Ok(())
    }

    /// Ends playback on the device (Cast: stops the receiver app) and closes connections. Best effort.
    fn close(&mut self);

    /// How often `status` should be called while playing.
    fn poll_interval(&self) -> Duration {
        Duration::from_secs(1)
    }
}

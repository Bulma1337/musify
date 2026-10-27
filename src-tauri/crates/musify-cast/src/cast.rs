//! Cast v2 renderer: launches the default media receiver and controls it over the media namespace.
//!
//! Nothing here logs payloads: the LOAD request carries the secret stream URL. Only message types
//! are ever logged.

use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme};
use serde_json::{Map, Value, json};

use crate::castv2::{
    CastChannel, CastError, CastMessage, NS_CONNECTION, NS_HEARTBEAT, NS_MEDIA, NS_RECEIVER,
};
use crate::gate::NetGate;
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus, TransportState};

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

const SENDER: &str = "sender-0";
const RECEIVER: &str = "receiver-0";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Read timeout on the socket: how long `poll` waits for data, so ticks return quickly.
const POLL_TIMEOUT: Duration = Duration::from_millis(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound of messages handled per `tick`, so a chatty device can't hold the session thread.
const MAX_MESSAGES_PER_TICK: usize = 64;

/// The application the receiver reports as running.
#[derive(Clone, Debug)]
struct AppInfo {
    app_id: String,
    session_id: Option<String>,
    transport_id: Option<String>,
}

/// One entry of a `MEDIA_STATUS` message.
#[derive(Clone, Debug, Default)]
struct MediaEntry {
    media_session_id: Option<i64>,
    player_state: Option<String>,
    idle_reason: Option<String>,
    current_time_ms: Option<u64>,
    duration_ms: Option<u64>,
}

pub struct CastRenderer<S: Read + Write + Send> {
    gate: Arc<NetGate>,
    /// `None` after `close`.
    channel: Option<CastChannel<S>>,
    next_request_id: u64,
    /// Transport of the media app (destination of media messages); empty until it is known.
    transport_id: String,
    /// Session of the media app, for STOP on close. Also what we watch for being replaced.
    session_id: Option<String>,
    /// The default media receiver as the last `RECEIVER_STATUS` listed it.
    default_app: Option<AppInfo>,
    media_session_id: Option<i64>,
    /// The loaded URL (secret): only handed back through `status`, never logged.
    current_url: Option<String>,
    volume: Option<f64>,
    duration_ms: Option<u64>,
    /// `Finished`/`Failed` as the device last broadcast it for our media session. The receiver
    /// drops the session afterwards, so a later `GET_STATUS` comes back empty.
    ended: Option<TransportState>,
    taken_over: bool,
    last_rx: Instant,
    last_ping: Instant,
}

/// The TLS stream the app uses.
pub type CastTlsStream = rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>;

impl CastRenderer<CastTlsStream> {
    /// Connects through `gate` (TCP + TLS; Cast devices use self-signed certificates), opens the
    /// virtual connection, launches the default media receiver (or joins it if it already runs) and
    /// connects to its transport.
    pub fn connect(gate: Arc<NetGate>, addr: SocketAddr) -> Result<Self, RendererError> {
        let tcp = gate
            .tcp_connect(addr, CONNECT_TIMEOUT)
            .map_err(|e| RendererError::Connection(format!("connect failed: {e}")))?;
        let tls = tls_handshake(tcp, addr.ip())?;
        Self::over_stream(gate, tls)
    }
}

impl<S: Read + Write + Send> CastRenderer<S> {
    /// Same as `connect`, over an already open stream (tests use plain TCP on localhost).
    ///
    /// The stream needs a short read timeout (the TLS path sets ~30 ms), otherwise waiting for
    /// replies can't time out.
    pub fn over_stream(gate: Arc<NetGate>, stream: S) -> Result<Self, RendererError> {
        let now = Instant::now();
        let mut renderer = Self {
            gate,
            channel: Some(CastChannel::new(stream)),
            next_request_id: 1,
            transport_id: String::new(),
            session_id: None,
            default_app: None,
            media_session_id: None,
            current_url: None,
            volume: None,
            duration_ms: None,
            ended: None,
            taken_over: false,
            last_rx: now,
            last_ping: now,
        };
        renderer.send_json(NS_CONNECTION, RECEIVER, connect_payload())?;
        renderer.request(NS_RECEIVER, RECEIVER, "GET_STATUS", Map::new())?;

        let app = match renderer.default_app.clone() {
            Some(app) => app,
            None => renderer.launch()?,
        };
        let transport_id = app.transport_id.unwrap_or_default();
        renderer.session_id = app.session_id;
        renderer.send_json(NS_CONNECTION, &transport_id, connect_payload())?;
        renderer.transport_id = transport_id;
        Ok(renderer)
    }

    /// Starts the default media receiver and waits for a receiver status that lists it as running.
    fn launch(&mut self) -> Result<AppInfo, RendererError> {
        self.ensure_alive()?;
        let id = self.next_id();
        let fields = object(json!({ "appId": DEFAULT_MEDIA_RECEIVER }));
        self.send_json(NS_RECEIVER, RECEIVER, request_payload("LAUNCH", id, fields))?;

        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        loop {
            if let Some(msg) = self.recv()?
                && let Some(reply) = self.process(msg)?
            {
                if request_id(&reply) == Some(id)
                    && let Some(reason) = reject_reason(&reply)
                {
                    return Err(RendererError::Rejected(reason));
                }
                if message_type(&reply) == "RECEIVER_STATUS"
                    && let Some(app) = self.default_app.clone()
                {
                    return Ok(app);
                }
            }
            if Instant::now() >= deadline {
                return Err(RendererError::Connection(
                    "the media receiver did not start".into(),
                ));
            }
        }
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    fn ensure_alive(&self) -> Result<(), RendererError> {
        if self.taken_over {
            return Err(RendererError::TakenOver);
        }
        self.gate.check().map_err(io_error)
    }

    fn send_json(
        &mut self,
        namespace: &str,
        destination: &str,
        payload: String,
    ) -> Result<(), RendererError> {
        self.gate.check().map_err(io_error)?;
        let channel = self.channel.as_mut().ok_or_else(closed_error)?;
        channel
            .send(&CastMessage {
                source_id: SENDER.into(),
                destination_id: destination.into(),
                namespace: namespace.into(),
                payload,
            })
            .map_err(cast_error)
    }

    /// The next complete message, if one arrived within the socket's read timeout.
    fn recv(&mut self) -> Result<Option<CastMessage>, RendererError> {
        self.gate.check().map_err(io_error)?;
        let channel = self.channel.as_mut().ok_or_else(closed_error)?;
        match channel.poll() {
            Ok(msg) => Ok(msg),
            Err(CastError::Invalid(_)) => {
                log::debug!("ignoring an undecodable Cast message");
                Ok(None)
            }
            Err(e) => Err(cast_error(e)),
        }
    }

    /// Housekeeping for every incoming message (heartbeat, takeover detection, cached state).
    /// Returns the parsed JSON of receiver and media messages, which callers may be waiting for.
    fn process(&mut self, msg: CastMessage) -> Result<Option<Value>, RendererError> {
        self.last_rx = Instant::now();
        let Ok(json) = serde_json::from_str::<Value>(&msg.payload) else {
            return Ok(None);
        };
        let kind = message_type(&json);
        log::trace!("cast message {kind}");
        match msg.namespace.as_str() {
            NS_HEARTBEAT => {
                if kind == "PING" {
                    self.send_json(NS_HEARTBEAT, &msg.source_id, pong_payload())?;
                }
                Ok(None)
            }
            NS_CONNECTION => {
                if kind == "CLOSE" {
                    if !self.transport_id.is_empty() && msg.source_id == self.transport_id {
                        self.taken_over = true;
                        return Err(RendererError::TakenOver);
                    }
                    if msg.source_id == RECEIVER {
                        return Err(RendererError::Connection(
                            "the device closed the connection".into(),
                        ));
                    }
                }
                Ok(None)
            }
            NS_RECEIVER => {
                if kind == "RECEIVER_STATUS" {
                    self.on_receiver_status(&json)?;
                }
                Ok(Some(json))
            }
            NS_MEDIA => {
                if kind == "MEDIA_STATUS" {
                    self.on_media_status(&json);
                }
                Ok(Some(json))
            }
            _ => Ok(None),
        }
    }

    fn on_receiver_status(&mut self, json: &Value) -> Result<(), RendererError> {
        if let Some(level) = receiver_volume(json) {
            self.volume = Some(level);
        }
        let apps = receiver_apps(json);
        self.default_app = apps
            .iter()
            .find(|a| a.app_id == DEFAULT_MEDIA_RECEIVER && a.transport_id.is_some())
            .cloned();
        if let Some(session) = &self.session_id
            && !apps.iter().any(|a| a.session_id.as_ref() == Some(session))
        {
            self.taken_over = true;
            return Err(RendererError::TakenOver);
        }
        Ok(())
    }

    fn on_media_status(&mut self, json: &Value) {
        for entry in media_entries(json) {
            if entry.media_session_id.is_none() || entry.media_session_id != self.media_session_id {
                continue;
            }
            if entry.duration_ms.is_some() {
                self.duration_ms = entry.duration_ms;
            }
            let state = entry_state(&entry);
            self.ended =
                matches!(state, TransportState::Finished | TransportState::Failed).then_some(state);
        }
    }

    /// Sends a request and waits for the message that carries its `requestId`.
    fn request(
        &mut self,
        namespace: &str,
        destination: &str,
        kind: &str,
        fields: Map<String, Value>,
    ) -> Result<Value, RendererError> {
        self.ensure_alive()?;
        let id = self.next_id();
        self.send_json(namespace, destination, request_payload(kind, id, fields))?;

        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if let Some(msg) = self.recv()?
                && let Some(reply) = self.process(msg)?
                && request_id(&reply) == Some(id)
            {
                return match reject_reason(&reply) {
                    Some(reason) => Err(RendererError::Rejected(reason)),
                    None => Ok(reply),
                };
            }
            if Instant::now() >= deadline {
                return Err(RendererError::Connection(
                    "the device did not answer".into(),
                ));
            }
        }
    }

    fn media_request(
        &mut self,
        kind: &str,
        fields: Map<String, Value>,
    ) -> Result<Value, RendererError> {
        let transport = self.transport_id.clone();
        self.request(NS_MEDIA, &transport, kind, fields)
    }

    /// PLAY, PAUSE, STOP and SEEK all address the current media session.
    fn control(&mut self, kind: &str, mut fields: Map<String, Value>) -> Result<(), RendererError> {
        let session = self
            .media_session_id
            .ok_or_else(|| RendererError::Rejected("nothing loaded".into()))?;
        fields.insert("mediaSessionId".into(), session.into());
        self.media_request(kind, fields).map(|_| ())
    }
}

impl<S: Read + Write + Send> Renderer for CastRenderer<S> {
    fn supported_mimes(&self) -> Vec<String> {
        CAST_AUDIO_MIMES.iter().map(|m| m.to_string()).collect()
    }

    fn max_sample_rate(&self) -> Option<u32> {
        Some(CAST_MAX_SAMPLE_RATE)
    }

    fn load(&mut self, item: &MediaItem, start_ms: u64, play: bool) -> Result<(), RendererError> {
        let reply = self.media_request("LOAD", load_fields(item, start_ms, play))?;
        let entries = media_entries(&reply);
        let Some(first) = entries.first() else {
            return Err(RendererError::Rejected(
                "the device did not report a media session".into(),
            ));
        };
        if entry_state(first) == TransportState::Failed {
            return Err(RendererError::Rejected(
                "the device could not play the item".into(),
            ));
        }
        let Some(session) = first.media_session_id else {
            return Err(RendererError::Rejected(
                "the device did not report a media session".into(),
            ));
        };
        self.media_session_id = Some(session);
        self.current_url = Some(item.url.clone());
        self.duration_ms = first.duration_ms.or(item.duration_ms);
        self.ended = None;
        Ok(())
    }

    fn set_next(&mut self, _item: Option<&MediaItem>) -> Result<(), RendererError> {
        Err(RendererError::Unsupported)
    }

    fn play(&mut self) -> Result<(), RendererError> {
        self.control("PLAY", Map::new())
    }

    fn pause(&mut self) -> Result<(), RendererError> {
        self.control("PAUSE", Map::new())
    }

    fn stop(&mut self) -> Result<(), RendererError> {
        self.control("STOP", Map::new())?;
        self.media_session_id = None;
        Ok(())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), RendererError> {
        self.control(
            "SEEK",
            object(json!({ "currentTime": position_ms as f64 / 1000.0 })),
        )
    }

    fn set_volume(&mut self, volume: f64) -> Result<(), RendererError> {
        let level = if volume.is_nan() {
            0.0
        } else {
            volume.clamp(0.0, 1.0)
        };
        let fields = object(json!({ "volume": { "level": level } }));
        self.request(NS_RECEIVER, RECEIVER, "SET_VOLUME", fields)?;
        self.volume = Some(level);
        Ok(())
    }

    fn status(&mut self) -> Result<RendererStatus, RendererError> {
        let mut fields = Map::new();
        if let Some(session) = self.media_session_id {
            fields.insert("mediaSessionId".into(), session.into());
        }
        let reply = self.media_request("GET_STATUS", fields)?;
        let entries = media_entries(&reply);
        let first = entries.first();
        if let Some(entry) = first {
            if self.media_session_id.is_none() {
                self.media_session_id = entry.media_session_id;
            }
            if entry.duration_ms.is_some() {
                self.duration_ms = entry.duration_ms;
            }
        }
        let state = match first {
            Some(entry) => entry_state(entry),
            None => self.ended.unwrap_or(TransportState::Stopped),
        };
        Ok(RendererStatus {
            state,
            position_ms: first.and_then(|e| e.current_time_ms),
            duration_ms: self.duration_ms,
            current_url: self.current_url.clone(),
            volume: self.volume,
        })
    }

    fn tick(&mut self) -> Result<(), RendererError> {
        self.ensure_alive()?;
        for _ in 0..MAX_MESSAGES_PER_TICK {
            match self.recv()? {
                Some(msg) => {
                    self.process(msg)?;
                }
                None => break,
            }
        }
        if self.last_rx.elapsed() > HEARTBEAT_TIMEOUT {
            return Err(RendererError::Connection("no heartbeat".into()));
        }
        if self.last_ping.elapsed() >= PING_INTERVAL {
            self.send_json(NS_HEARTBEAT, RECEIVER, ping_payload())?;
            self.last_ping = Instant::now();
        }
        Ok(())
    }

    fn close(&mut self) {
        if self.channel.is_none() {
            return;
        }
        if !self.taken_over
            && let Some(session) = self.session_id.clone()
        {
            let id = self.next_id();
            let fields = object(json!({ "sessionId": session }));
            let _ = self.send_json(NS_RECEIVER, RECEIVER, request_payload("STOP", id, fields));
        }
        let close = close_payload();
        if !self.transport_id.is_empty() {
            let transport = self.transport_id.clone();
            let _ = self.send_json(NS_CONNECTION, &transport, close.clone());
        }
        let _ = self.send_json(NS_CONNECTION, RECEIVER, close);
        self.channel = None;
    }
}

fn io_error(e: io::Error) -> RendererError {
    RendererError::Connection(e.to_string())
}

fn closed_error() -> RendererError {
    RendererError::Connection("connection closed".into())
}

fn cast_error(e: CastError) -> RendererError {
    match e {
        CastError::Io(e) => io_error(e),
        CastError::Invalid(_) | CastError::TooLarge(_) => {
            RendererError::Connection("protocol error".into())
        }
    }
}

// --- Message building and parsing (pure) -----------------------------------------------------

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn connect_payload() -> String {
    json!({ "type": "CONNECT" }).to_string()
}

fn close_payload() -> String {
    json!({ "type": "CLOSE" }).to_string()
}

fn ping_payload() -> String {
    json!({ "type": "PING" }).to_string()
}

fn pong_payload() -> String {
    json!({ "type": "PONG" }).to_string()
}

fn request_payload(kind: &str, request_id: u64, mut fields: Map<String, Value>) -> String {
    fields.insert("type".into(), kind.into());
    fields.insert("requestId".into(), request_id.into());
    Value::Object(fields).to_string()
}

/// Everything of a `LOAD` request except `type` and `requestId`. Fields that are `None` are left out.
fn load_fields(item: &MediaItem, start_ms: u64, play: bool) -> Map<String, Value> {
    let mut metadata = object(json!({ "metadataType": 3, "title": item.title }));
    if let Some(artist) = &item.artist {
        metadata.insert("artist".into(), artist.as_str().into());
    }
    if let Some(album) = &item.album {
        metadata.insert("albumName".into(), album.as_str().into());
    }
    if let Some(cover) = &item.cover_url {
        metadata.insert("images".into(), json!([{ "url": cover }]));
    }
    let mut media = object(json!({
        "contentId": item.url,
        "contentType": item.mime,
        "streamType": "BUFFERED",
    }));
    media.insert("metadata".into(), Value::Object(metadata));
    if let Some(duration_ms) = item.duration_ms {
        media.insert("duration".into(), (duration_ms as f64 / 1000.0).into());
    }
    object(json!({
        "media": media,
        "autoplay": play,
        "currentTime": start_ms as f64 / 1000.0,
    }))
}

fn message_type(json: &Value) -> &str {
    json.get("type").and_then(Value::as_str).unwrap_or("")
}

fn request_id(json: &Value) -> Option<u64> {
    json.get("requestId")
        .and_then(Value::as_u64)
        .filter(|&id| id != 0)
}

/// Why the device refused a request, without anything the device may have echoed back (the
/// message must never contain the media URL).
fn reject_reason(json: &Value) -> Option<String> {
    let kind = message_type(json);
    if !matches!(
        kind,
        "INVALID_REQUEST"
            | "LOAD_FAILED"
            | "LOAD_CANCELLED"
            | "LAUNCH_ERROR"
            | "INVALID_PLAYER_STATE"
    ) {
        return None;
    }
    let reason = json.get("reason").and_then(Value::as_str).filter(|r| {
        r.len() <= 48
            && r.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b' ')
    });
    Some(match reason {
        Some(reason) => format!("{kind}: {reason}"),
        None => kind.to_string(),
    })
}

fn receiver_volume(json: &Value) -> Option<f64> {
    json.pointer("/status/volume/level").and_then(Value::as_f64)
}

fn receiver_apps(json: &Value) -> Vec<AppInfo> {
    let text = |app: &Value, key: &str| app.get(key).and_then(Value::as_str).map(str::to_string);
    json.pointer("/status/applications")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|app| AppInfo {
            app_id: text(app, "appId").unwrap_or_default(),
            session_id: text(app, "sessionId"),
            transport_id: text(app, "transportId"),
        })
        .collect()
}

fn seconds_to_ms(value: &Value) -> Option<u64> {
    let seconds = value.as_f64().filter(|s| s.is_finite() && *s >= 0.0)?;
    Some((seconds * 1000.0).round() as u64)
}

fn media_entries(json: &Value) -> Vec<MediaEntry> {
    let text =
        |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
    json.get("status")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| MediaEntry {
            media_session_id: entry.get("mediaSessionId").and_then(Value::as_i64),
            player_state: text(entry, "playerState"),
            idle_reason: text(entry, "idleReason"),
            current_time_ms: entry.get("currentTime").and_then(seconds_to_ms),
            duration_ms: entry.pointer("/media/duration").and_then(seconds_to_ms),
        })
        .collect()
}

fn entry_state(entry: &MediaEntry) -> TransportState {
    match entry.player_state.as_deref() {
        Some("PLAYING") => TransportState::Playing,
        Some("PAUSED") => TransportState::Paused,
        Some("BUFFERING" | "LOADING") => TransportState::Buffering,
        Some("ERROR") => TransportState::Failed,
        Some("IDLE") => match entry.idle_reason.as_deref() {
            Some("FINISHED") => TransportState::Finished,
            Some("ERROR") => TransportState::Failed,
            _ => TransportState::Stopped,
        },
        _ => TransportState::Stopped,
    }
}

// --- TLS --------------------------------------------------------------------------------------

fn tls_handshake(mut tcp: TcpStream, ip: IpAddr) -> Result<CastTlsStream, RendererError> {
    let tls_error = |what: &str, e: &dyn std::fmt::Display| {
        RendererError::Connection(format!("TLS {what}: {e}"))
    };

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| tls_error("setup failed", &e))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert { provider }))
        .with_no_client_auth();
    let mut conn = ClientConnection::new(Arc::new(config), ServerName::IpAddress(ip.into()))
        .map_err(|e| tls_error("setup failed", &e))?;

    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    while conn.is_handshaking() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(RendererError::Connection("TLS handshake timed out".into()));
        }
        tcp.set_read_timeout(Some(left)).map_err(io_error)?;
        tcp.set_write_timeout(Some(left)).map_err(io_error)?;
        conn.complete_io(&mut tcp).map_err(|e| match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => {
                RendererError::Connection("TLS handshake timed out".into())
            }
            _ => tls_error("handshake failed", &e),
        })?;
    }
    tcp.set_read_timeout(Some(POLL_TIMEOUT)).map_err(io_error)?;
    tcp.set_write_timeout(Some(WRITE_TIMEOUT))
        .map_err(io_error)?;
    // Small request/reply messages: don't wait for Nagle.
    let _ = tcp.set_nodelay(true);
    Ok(rustls::StreamOwned::new(conn, tcp))
}

/// Cast devices present self-signed certificates, so any certificate is accepted. Handshake
/// signatures are still checked, which binds the connection to the presented key.
#[derive(Debug)]
struct AcceptAnyCert {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> MediaItem {
        MediaItem {
            url: "http://192.168.1.2:4000/t/SECRET/1.flac".into(),
            mime: "audio/flac".into(),
            title: "Song".into(),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            cover_url: Some("http://192.168.1.2:4000/c/SECRET/1.jpg".into()),
            duration_ms: Some(215_500),
            seekable: true,
        }
    }

    #[test]
    fn load_request_has_all_fields() {
        let payload = request_payload("LOAD", 7, load_fields(&item(), 12_250, true));
        let json: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(json["type"], "LOAD");
        assert_eq!(json["requestId"], 7);
        assert_eq!(json["autoplay"], true);
        assert_eq!(json["currentTime"].as_f64(), Some(12.25));
        let media = &json["media"];
        assert_eq!(
            media["contentId"],
            "http://192.168.1.2:4000/t/SECRET/1.flac"
        );
        assert_eq!(media["contentType"], "audio/flac");
        assert_eq!(media["streamType"], "BUFFERED");
        assert_eq!(media["duration"].as_f64(), Some(215.5));
        assert_eq!(media["metadata"]["metadataType"], 3);
        assert_eq!(media["metadata"]["title"], "Song");
        assert_eq!(media["metadata"]["artist"], "Artist");
        assert_eq!(media["metadata"]["albumName"], "Album");
        assert_eq!(
            media["metadata"]["images"][0]["url"],
            "http://192.168.1.2:4000/c/SECRET/1.jpg"
        );
    }

    #[test]
    fn load_request_leaves_out_missing_fields() {
        let bare = MediaItem {
            artist: None,
            album: None,
            cover_url: None,
            duration_ms: None,
            ..item()
        };
        let json = Value::Object(load_fields(&bare, 0, false));
        assert_eq!(json["autoplay"], false);
        assert_eq!(json["currentTime"].as_f64(), Some(0.0));
        let media = json["media"].as_object().unwrap();
        assert!(!media.contains_key("duration"));
        let metadata = media["metadata"].as_object().unwrap();
        assert_eq!(metadata.len(), 2);
        assert!(
            !metadata.contains_key("artist")
                && !metadata.contains_key("albumName")
                && !metadata.contains_key("images")
        );
    }

    fn state_of(entry: Value) -> TransportState {
        entry_state(&media_entries(&json!({ "status": [entry] }))[0])
    }

    #[test]
    fn player_states_map_to_transport_states() {
        use TransportState::*;
        assert_eq!(state_of(json!({ "playerState": "PLAYING" })), Playing);
        assert_eq!(state_of(json!({ "playerState": "PAUSED" })), Paused);
        assert_eq!(state_of(json!({ "playerState": "BUFFERING" })), Buffering);
        assert_eq!(state_of(json!({ "playerState": "LOADING" })), Buffering);
        assert_eq!(state_of(json!({ "playerState": "ERROR" })), Failed);
        assert_eq!(
            state_of(json!({ "playerState": "IDLE", "idleReason": "FINISHED" })),
            Finished
        );
        assert_eq!(
            state_of(json!({ "playerState": "IDLE", "idleReason": "ERROR" })),
            Failed
        );
        assert_eq!(
            state_of(json!({ "playerState": "IDLE", "idleReason": "CANCELLED" })),
            Stopped
        );
        assert_eq!(
            state_of(json!({ "playerState": "IDLE", "idleReason": "INTERRUPTED" })),
            Stopped
        );
        assert_eq!(state_of(json!({ "playerState": "IDLE" })), Stopped);
        assert_eq!(state_of(json!({})), Stopped);
        assert!(media_entries(&json!({ "status": [] })).is_empty());
        assert!(media_entries(&json!({})).is_empty());
    }

    #[test]
    fn media_entry_times_are_milliseconds() {
        let entries = media_entries(&json!({
            "status": [{ "mediaSessionId": 3, "currentTime": 12.3456, "media": { "duration": 200.0 } }]
        }));
        assert_eq!(entries[0].media_session_id, Some(3));
        assert_eq!(entries[0].current_time_ms, Some(12_346));
        assert_eq!(entries[0].duration_ms, Some(200_000));
        assert_eq!(seconds_to_ms(&json!(-1.0)), None);
    }

    #[test]
    fn receiver_status_is_parsed() {
        let status = json!({
            "type": "RECEIVER_STATUS",
            "status": {
                "applications": [
                    { "appId": "CC1AD845", "sessionId": "s1", "transportId": "t1" },
                    { "appId": "OTHER" },
                ],
                "volume": { "level": 0.4, "muted": false },
            }
        });
        let apps = receiver_apps(&status);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].transport_id.as_deref(), Some("t1"));
        assert_eq!(apps[0].session_id.as_deref(), Some("s1"));
        assert_eq!(apps[1].transport_id, None);
        assert_eq!(receiver_volume(&status), Some(0.4));
        assert!(receiver_apps(&json!({ "status": { "isActiveInput": true } })).is_empty());
    }

    #[test]
    fn rejections_never_echo_the_payload() {
        let failed = json!({ "type": "LOAD_FAILED", "requestId": 4, "detailedErrorCode": 905, "url": "http://x/SECRET" });
        assert_eq!(reject_reason(&failed).as_deref(), Some("LOAD_FAILED"));
        let invalid = json!({ "type": "INVALID_REQUEST", "reason": "INVALID_COMMAND" });
        assert_eq!(
            reject_reason(&invalid).as_deref(),
            Some("INVALID_REQUEST: INVALID_COMMAND")
        );
        let echoing = json!({ "type": "INVALID_REQUEST", "reason": "http://192.168.1.2/SECRET" });
        assert_eq!(reject_reason(&echoing).as_deref(), Some("INVALID_REQUEST"));
        assert_eq!(reject_reason(&json!({ "type": "MEDIA_STATUS" })), None);
    }

    #[test]
    fn request_ids_zero_are_broadcasts() {
        assert_eq!(request_id(&json!({ "requestId": 0 })), None);
        assert_eq!(request_id(&json!({})), None);
        assert_eq!(request_id(&json!({ "requestId": 9 })), Some(9));
    }
}

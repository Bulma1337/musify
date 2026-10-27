//! UPnP AV / DLNA MediaRenderer control: AVTransport, RenderingControl and ConnectionManager over SOAP.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use musify_audio::source::{BlockingClient, describe_io, describe_reqwest};

use crate::gate::NetGate;
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus, TransportState};
use crate::upnp::{
    DeviceDescription, ServiceInfo, UpnpError, didl_lite, format_time, parse_soap_response,
    parse_time, protocol_info_for, sink_mimes, soap_action_header, soap_envelope,
};

/// Per request; a renderer that doesn't answer in this time is treated as gone.
const SOAP_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_LIMIT: u64 = 64 * 1024;
/// How long `load` waits for the device to start playing before it seeks to the start position.
const PLAYING_WAIT: Duration = Duration::from_secs(5);
const PLAYING_POLL: Duration = Duration::from_millis(200);
/// Below this a start position is not worth a seek (and many devices reject it right after `Play`).
const MIN_START_SEEK_MS: u64 = 1000;
/// `GetVolume` runs on the first `status` call and then on every n-th one.
const VOLUME_EVERY: u32 = 5;

const INSTANCE: (&str, &str) = ("InstanceID", "0");

type Reply = HashMap<String, String>;

pub struct DlnaRenderer {
    gate: Arc<NetGate>,
    client: BlockingClient,
    av_transport: ServiceInfo,
    rendering_control: Option<ServiceInfo>,
    mimes: Vec<String>,
    /// The device answered `SetNextAVTransportURI` with "not implemented".
    next_unsupported: bool,
    /// Start position of a `load(.., play = false)`, applied by the next `play`.
    pending_seek_ms: Option<u64>,
    volume: Option<f64>,
    status_calls: u32,
}

/// A failed SOAP call; the fault code stays visible for the few callers that react to it.
enum CallError {
    Fault(u32),
    Failed(RendererError),
}

impl DlnaRenderer {
    /// Checks that the device has AVTransport and reads its supported formats once
    /// (`GetProtocolInfo`; a failure leaves the list empty = unknown). Every later request first
    /// checks `gate` and fails with `RendererError::Connection` once it is closed.
    pub fn connect(
        gate: Arc<NetGate>,
        client: BlockingClient,
        description: &DeviceDescription,
    ) -> Result<Self, RendererError> {
        gate.check()
            .map_err(|err| RendererError::Connection(err.to_string()))?;
        let av_transport = description.av_transport.clone().ok_or_else(|| {
            RendererError::Rejected("the device has no AVTransport service".into())
        })?;
        let mut renderer = Self {
            gate,
            client,
            av_transport,
            rendering_control: description.rendering_control.clone(),
            mimes: Vec::new(),
            next_unsupported: false,
            pending_seek_ms: None,
            volume: None,
            status_calls: 0,
        };
        if let Some(manager) = &description.connection_manager
            && let Ok(reply) = renderer.call(manager, "GetProtocolInfo", &[])
        {
            renderer.mimes = reply
                .get("Sink")
                .map(|sink| sink_mimes(sink))
                .unwrap_or_default();
        }
        Ok(renderer)
    }

    fn call(
        &self,
        service: &ServiceInfo,
        action: &str,
        args: &[(&str, &str)],
    ) -> Result<Reply, RendererError> {
        self.send(service, action, args).map_err(|err| match err {
            CallError::Fault(code) => fault_error(code, action),
            CallError::Failed(err) => err,
        })
    }

    fn av(&self, action: &str, args: &[(&str, &str)]) -> Result<Reply, RendererError> {
        self.call(&self.av_transport, action, args)
    }

    fn rendering(&self, action: &str, args: &[(&str, &str)]) -> Result<Reply, RendererError> {
        match &self.rendering_control {
            Some(service) => self.call(service, action, args),
            None => Err(RendererError::Unsupported),
        }
    }

    /// One SOAP round trip. The error messages name the action and the UPnP code, never a URL.
    fn send(
        &self,
        service: &ServiceInfo,
        action: &str,
        args: &[(&str, &str)],
    ) -> Result<Reply, CallError> {
        let connection = |message: String| CallError::Failed(RendererError::Connection(message));
        self.gate
            .check()
            .map_err(|err| connection(err.to_string()))?;

        let url = &service.control_url;
        let response = self
            .client
            .post(url)
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header(
                "SOAPACTION",
                soap_action_header(&service.service_type, action),
            )
            .timeout(SOAP_TIMEOUT)
            .body(soap_envelope(&service.service_type, action, args))
            .send()
            .map_err(|err| connection(describe_reqwest(err, url)))?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        response
            .take(RESPONSE_LIMIT)
            .read_to_end(&mut body)
            .map_err(|err| connection(describe_io(&err, url)))?;

        let rejected =
            |what: &str| CallError::Failed(RendererError::Rejected(format!("{what} ({action})")));
        match parse_soap_response(&String::from_utf8_lossy(&body), action) {
            Err(UpnpError::Fault { code, .. }) => Err(CallError::Fault(code)),
            _ if status >= 400 => Err(rejected(&format!("HTTP error {status}"))),
            Ok(reply) => Ok(reply),
            // Many renderers answer simple actions with an empty or sloppy body; the status says it worked.
            Err(_) => Ok(Reply::new()),
        }
    }

    fn set_uri(&self, item: &MediaItem) -> Result<Reply, CallError> {
        let metadata = didl_lite(item, &protocol_info_for(&item.mime, item.seekable));
        self.send(
            &self.av_transport,
            "SetAVTransportURI",
            &[
                INSTANCE,
                ("CurrentURI", &item.url),
                ("CurrentURIMetaData", &metadata),
            ],
        )
    }

    /// Waits until the device reports PLAYING (or PAUSED_PLAYBACK) and seeks to `start_ms`. A device
    /// that never gets there, or refuses the seek, plays from the start rather than failing the load.
    fn seek_to_start(&mut self, start_ms: u64) -> Result<(), RendererError> {
        if start_ms < MIN_START_SEEK_MS {
            return Ok(());
        }
        let deadline = Instant::now() + PLAYING_WAIT;
        loop {
            match self.av("GetTransportInfo", &[INSTANCE]) {
                Ok(reply) => {
                    let state = reply.get("CurrentTransportState").map(String::as_str);
                    if matches!(state, Some("PLAYING" | "PAUSED_PLAYBACK")) {
                        break;
                    }
                }
                Err(err @ (RendererError::Connection(_) | RendererError::TakenOver)) => {
                    return Err(err);
                }
                Err(_) => break,
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(PLAYING_POLL);
        }
        match self.seek_rel(start_ms) {
            Err(RendererError::Rejected(_) | RendererError::Unsupported) => {
                log::debug!("network speaker: start position not applied");
                Ok(())
            }
            other => other,
        }
    }

    fn seek_rel(&self, position_ms: u64) -> Result<(), RendererError> {
        let target = format_time(position_ms);
        self.av(
            "Seek",
            &[INSTANCE, ("Unit", "REL_TIME"), ("Target", &target)],
        )
        .map(drop)
    }
}

/// 401 (Invalid Action) and 602 (Optional Action Not Implemented) mean the device lacks the action.
fn fault_error(code: u32, action: &str) -> RendererError {
    match code {
        401 | 602 => RendererError::Unsupported,
        _ => RendererError::Rejected(format!("UPnP error {code} ({action})")),
    }
}

fn map_state(state: Option<&str>, transport_status: Option<&str>) -> TransportState {
    if transport_status == Some("ERROR_OCCURRED") {
        return TransportState::Failed;
    }
    match state {
        Some("PLAYING") => TransportState::Playing,
        Some("PAUSED_PLAYBACK" | "PAUSED_RECORDING") => TransportState::Paused,
        Some("TRANSITIONING") => TransportState::Buffering,
        _ => TransportState::Stopped,
    }
}

/// `None` for empty values and `NOT_IMPLEMENTED`.
fn present(reply: &Reply, key: &str) -> Option<String> {
    reply
        .get(key)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("NOT_IMPLEMENTED"))
        .cloned()
}

impl Renderer for DlnaRenderer {
    fn supported_mimes(&self) -> Vec<String> {
        self.mimes.clone()
    }

    fn load(&mut self, item: &MediaItem, start_ms: u64, play: bool) -> Result<(), RendererError> {
        self.pending_seek_ms = None;
        match self.set_uri(item) {
            Ok(_) => {}
            // Transition not available / locked: the device is busy with something else.
            Err(CallError::Fault(701 | 705)) => {
                let _ = self.av("Stop", &[INSTANCE]);
                self.set_uri(item).map_err(|err| match err {
                    CallError::Fault(code) => fault_error(code, "SetAVTransportURI"),
                    CallError::Failed(err) => err,
                })?;
            }
            Err(CallError::Fault(code)) => return Err(fault_error(code, "SetAVTransportURI")),
            Err(CallError::Failed(err)) => return Err(err),
        }
        if play {
            self.av("Play", &[INSTANCE, ("Speed", "1")])?;
            self.seek_to_start(start_ms)
        } else {
            self.pending_seek_ms = (start_ms >= MIN_START_SEEK_MS).then_some(start_ms);
            Ok(())
        }
    }

    fn set_next(&mut self, item: Option<&MediaItem>) -> Result<(), RendererError> {
        if self.next_unsupported {
            return Err(RendererError::Unsupported);
        }
        let metadata =
            item.map(|item| didl_lite(item, &protocol_info_for(&item.mime, item.seekable)));
        let uri = item.map_or("", |item| item.url.as_str());
        let result = self.av(
            "SetNextAVTransportURI",
            &[
                INSTANCE,
                ("NextURI", uri),
                ("NextURIMetaData", metadata.as_deref().unwrap_or("")),
            ],
        );
        if matches!(result, Err(RendererError::Unsupported)) {
            self.next_unsupported = true;
        }
        result.map(drop)
    }

    fn play(&mut self) -> Result<(), RendererError> {
        self.av("Play", &[INSTANCE, ("Speed", "1")])?;
        match self.pending_seek_ms.take() {
            Some(start_ms) => self.seek_to_start(start_ms),
            None => Ok(()),
        }
    }

    fn pause(&mut self) -> Result<(), RendererError> {
        self.av("Pause", &[INSTANCE]).map(drop)
    }

    fn stop(&mut self) -> Result<(), RendererError> {
        self.pending_seek_ms = None;
        self.av("Stop", &[INSTANCE]).map(drop)
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), RendererError> {
        self.pending_seek_ms = None;
        self.seek_rel(position_ms)
    }

    fn set_volume(&mut self, volume: f64) -> Result<(), RendererError> {
        let percent = (volume * 100.0).round().clamp(0.0, 100.0) as u32;
        self.rendering(
            "SetVolume",
            &[
                INSTANCE,
                ("Channel", "Master"),
                ("DesiredVolume", &percent.to_string()),
            ],
        )?;
        self.volume = Some(f64::from(percent) / 100.0);
        Ok(())
    }

    fn status(&mut self) -> Result<RendererStatus, RendererError> {
        let info = self.av("GetTransportInfo", &[INSTANCE])?;
        let state = map_state(
            info.get("CurrentTransportState").map(String::as_str),
            info.get("CurrentTransportStatus").map(String::as_str),
        );
        let position = match self.av("GetPositionInfo", &[INSTANCE]) {
            Ok(reply) => reply,
            // Some devices fault while nothing is loaded; that is a state, not a lost connection.
            Err(RendererError::Rejected(_) | RendererError::Unsupported) => Reply::new(),
            Err(err) => return Err(err),
        };

        if self.rendering_control.is_some() && self.status_calls.is_multiple_of(VOLUME_EVERY) {
            let reply = self.rendering("GetVolume", &[INSTANCE, ("Channel", "Master")]);
            if let Some(percent) = reply
                .ok()
                .and_then(|r| r.get("CurrentVolume")?.parse::<u32>().ok())
            {
                self.volume = Some((f64::from(percent) / 100.0).clamp(0.0, 1.0));
            }
        }
        self.status_calls = self.status_calls.wrapping_add(1);

        Ok(RendererStatus {
            state,
            position_ms: present(&position, "RelTime").and_then(|t| parse_time(&t)),
            duration_ms: present(&position, "TrackDuration").and_then(|t| parse_time(&t)),
            current_url: present(&position, "TrackURI"),
            volume: self.volume,
        })
    }

    fn close(&mut self) {
        let _ = self.av("Stop", &[INSTANCE]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_transport_states() {
        assert_eq!(
            map_state(Some("PLAYING"), Some("OK")),
            TransportState::Playing
        );
        assert_eq!(
            map_state(Some("PAUSED_PLAYBACK"), None),
            TransportState::Paused
        );
        assert_eq!(
            map_state(Some("PAUSED_RECORDING"), None),
            TransportState::Paused
        );
        assert_eq!(
            map_state(Some("TRANSITIONING"), Some("OK")),
            TransportState::Buffering
        );
        assert_eq!(
            map_state(Some("STOPPED"), Some("OK")),
            TransportState::Stopped
        );
        assert_eq!(
            map_state(Some("NO_MEDIA_PRESENT"), None),
            TransportState::Stopped
        );
        assert_eq!(map_state(Some("WEIRD"), None), TransportState::Stopped);
        assert_eq!(map_state(None, None), TransportState::Stopped);
        assert_eq!(
            map_state(Some("PLAYING"), Some("ERROR_OCCURRED")),
            TransportState::Failed
        );
        assert_eq!(
            map_state(Some("STOPPED"), Some("ERROR_OCCURRED")),
            TransportState::Failed
        );
    }

    #[test]
    fn maps_fault_codes() {
        assert!(matches!(fault_error(401, "X"), RendererError::Unsupported));
        assert!(matches!(fault_error(602, "X"), RendererError::Unsupported));
        match fault_error(714, "SetAVTransportURI") {
            RendererError::Rejected(message) => {
                assert_eq!(message, "UPnP error 714 (SetAVTransportURI)")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn present_drops_empty_and_not_implemented() {
        let reply: Reply = [("a", "x"), ("b", ""), ("c", "NOT_IMPLEMENTED")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(present(&reply, "a").as_deref(), Some("x"));
        assert_eq!(present(&reply, "b"), None);
        assert_eq!(present(&reply, "c"), None);
        assert_eq!(present(&reply, "d"), None);
    }
}

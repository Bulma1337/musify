//! UPnP AV building blocks: device descriptions, SOAP envelopes and responses, DIDL-Lite metadata,
//! protocolInfo strings and the `H:MM:SS` time format. No sockets except `fetch_description`.

use std::collections::HashMap;

use musify_audio::source::BlockingClient;

use crate::renderer::MediaItem;

pub const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
pub const RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:RenderingControl:1";
pub const CONNECTION_MANAGER: &str = "urn:schemas-upnp-org:service:ConnectionManager:1";

#[derive(Debug, thiserror::Error)]
pub enum UpnpError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("invalid XML: {0}")]
    Xml(String),
    #[error("missing element: {0}")]
    Missing(&'static str),
    /// A SOAP fault with its UPnP error code (e.g. 401 Invalid Action, 701 Transition not available).
    #[error("UPnP error {code}: {description}")]
    Fault { code: u32, description: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceInfo {
    pub service_type: String,
    /// Absolute URL.
    pub control_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceDescription {
    pub udn: String,
    pub device_type: String,
    pub friendly_name: String,
    pub manufacturer: Option<String>,
    pub model_name: Option<String>,
    pub model_description: Option<String>,
    pub av_transport: Option<ServiceInfo>,
    pub rendering_control: Option<ServiceInfo>,
    pub connection_manager: Option<ServiceInfo>,
}

/// GETs and parses the description at `location` (timeout ~5 s, body limited to 256 KiB).
pub fn fetch_description(_client: &BlockingClient, _location: &str) -> Result<DeviceDescription, UpnpError> {
    todo!("upnp::fetch_description")
}

/// Parses a device description. Picks the root device or the first embedded device whose
/// `deviceType` is a MediaRenderer (any version); relative URLs resolve against `URLBase` if present,
/// otherwise against `location`.
pub fn parse_description(_xml: &str, _location: &str) -> Result<DeviceDescription, UpnpError> {
    todo!("upnp::parse_description")
}

/// SOAP 1.1 envelope for `action` of `service_type` with the arguments in order (values escaped).
pub fn soap_envelope(_service_type: &str, _action: &str, _args: &[(&str, &str)]) -> String {
    todo!("upnp::soap_envelope")
}

/// Value of the `SOAPACTION` header: `"<service_type>#<action>"` including the quotes.
pub fn soap_action_header(_service_type: &str, _action: &str) -> String {
    todo!("upnp::soap_action_header")
}

/// Output arguments of `<action>Response` by local name (unescaped), or the SOAP fault's UPnP error.
pub fn parse_soap_response(_xml: &str, _action: &str) -> Result<HashMap<String, String>, UpnpError> {
    todo!("upnp::parse_soap_response")
}

/// `http-get:*:<mime>:<DLNA flags>`: `DLNA.ORG_OP=01` (byte seek) when `seekable`, `00` otherwise;
/// `DLNA.ORG_CI=0`, streaming flags.
pub fn protocol_info_for(_mime: &str, _seekable: bool) -> String {
    todo!("upnp::protocol_info_for")
}

/// DIDL-Lite document for `item` (music track: title, artist, album, album art, `res` with
/// `protocolInfo` and `duration`), escaped for use as a text node (the caller escapes it again
/// inside the SOAP envelope via `soap_envelope`).
pub fn didl_lite(_item: &MediaItem, _protocol_info: &str) -> String {
    todo!("upnp::didl_lite")
}

/// Audio MIME types (lowercase, deduplicated, in order) of the `http-get` entries of a
/// `GetProtocolInfo` `Sink` list.
pub fn sink_mimes(_sink: &str) -> Vec<String> {
    todo!("upnp::sink_mimes")
}

/// `H:MM:SS` (hours unpadded), e.g. `0:03:05`; milliseconds are dropped.
pub fn format_time(_ms: u64) -> String {
    todo!("upnp::format_time")
}

/// Parses `H+:MM:SS[.F+]` (also `H:MM:SS.mmm`, and `F0/F1` fractions); `None` for empty strings and
/// `NOT_IMPLEMENTED`.
pub fn parse_time(_text: &str) -> Option<u64> {
    todo!("upnp::parse_time")
}

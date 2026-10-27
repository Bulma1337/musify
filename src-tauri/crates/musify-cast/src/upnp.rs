//! UPnP AV building blocks: device descriptions, SOAP envelopes and responses, DIDL-Lite metadata,
//! protocolInfo strings and the `H:MM:SS` time format. No sockets except `fetch_description`.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use musify_audio::source::{BlockingClient, describe_io, describe_reqwest};

use crate::renderer::MediaItem;

pub const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
pub const RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:RenderingControl:1";
pub const CONNECTION_MANAGER: &str = "urn:schemas-upnp-org:service:ConnectionManager:1";

const DESCRIPTION_TIMEOUT: Duration = Duration::from_secs(5);
const DESCRIPTION_LIMIT: u64 = 256 * 1024;

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
    /// Exactly as the device declares it (any version); used verbatim in SOAP requests.
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
pub fn fetch_description(client: &BlockingClient, location: &str) -> Result<DeviceDescription, UpnpError> {
    let response = client
        .get(location)
        .timeout(DESCRIPTION_TIMEOUT)
        .send()
        .map_err(|err| UpnpError::Http(describe_reqwest(err, location)))?;
    let status = response.status();
    if status.as_u16() >= 400 {
        return Err(UpnpError::Http(format!("status {}", status.as_u16())));
    }
    let mut body = Vec::new();
    response
        .take(DESCRIPTION_LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|err| UpnpError::Http(describe_io(&err, location)))?;
    if body.len() as u64 > DESCRIPTION_LIMIT {
        return Err(UpnpError::Http("description is too large".into()));
    }
    parse_description(&String::from_utf8_lossy(&body), location)
}

/// Parses a device description. Picks the root device or the first embedded device whose
/// `deviceType` is a MediaRenderer (any version); relative URLs resolve against `URLBase` if present,
/// otherwise against `location`.
pub fn parse_description(xml: &str, location: &str) -> Result<DeviceDescription, UpnpError> {
    let document = xml::parse(xml)?;
    let root = document.children.first().ok_or(UpnpError::Missing("root"))?;
    let root_device = root.child("device").ok_or(UpnpError::Missing("device"))?;
    let device = find_renderer(root_device).ok_or(UpnpError::Missing("MediaRenderer"))?;

    let base = root.child_text("URLBase").unwrap_or_else(|| location.to_string());
    let udn = device.child_text("UDN").ok_or(UpnpError::Missing("UDN"))?;
    let device_type = device.child_text("deviceType").unwrap_or_default();
    let model_name = device.child_text("modelName");
    let friendly_name = device
        .child_text("friendlyName")
        .or_else(|| model_name.clone())
        .unwrap_or_else(|| udn.clone());

    let mut av_transport = None;
    let mut rendering_control = None;
    let mut connection_manager = None;
    if let Some(list) = device.child("serviceList") {
        for service in list.children_named("service") {
            let (Some(service_type), Some(control)) = (service.child_text("serviceType"), service.child_text("controlURL"))
            else {
                continue;
            };
            let slot = if service_type.starts_with("urn:schemas-upnp-org:service:AVTransport:") {
                &mut av_transport
            } else if service_type.starts_with("urn:schemas-upnp-org:service:RenderingControl:") {
                &mut rendering_control
            } else if service_type.starts_with("urn:schemas-upnp-org:service:ConnectionManager:") {
                &mut connection_manager
            } else {
                continue;
            };
            if slot.is_none() {
                *slot = Some(ServiceInfo { service_type, control_url: resolve_url(&base, &control) });
            }
        }
    }

    Ok(DeviceDescription {
        udn,
        device_type,
        friendly_name,
        manufacturer: device.child_text("manufacturer"),
        model_name,
        model_description: device.child_text("modelDescription"),
        av_transport,
        rendering_control,
        connection_manager,
    })
}

/// The device itself if it is a MediaRenderer, else the first embedded one (depth first).
fn find_renderer(device: &xml::Node) -> Option<&xml::Node> {
    if device.child_text("deviceType").is_some_and(|t| t.contains(":MediaRenderer:")) {
        return Some(device);
    }
    device
        .child("deviceList")?
        .children_named("device")
        .find_map(find_renderer)
}

/// Resolves `reference` against `base` (RFC 3986 for the cases devices produce: absolute URLs,
/// `//host/path`, `/path` and `path`).
fn resolve_url(base: &str, reference: &str) -> String {
    let reference = reference.trim();
    let lower = reference.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return reference.to_string();
    }
    let base = base.trim();
    let Some(scheme_end) = base.find("://") else {
        return reference.to_string();
    };
    let after_scheme = scheme_end + 3;
    let authority_end = base[after_scheme..]
        .find(['/', '?', '#'])
        .map_or(base.len(), |i| after_scheme + i);
    let origin = &base[..authority_end];
    if let Some(rest) = reference.strip_prefix("//") {
        return format!("{}://{rest}", &base[..scheme_end]);
    }
    if reference.starts_with('/') {
        return format!("{origin}{}", normalize_path(reference));
    }
    let base_path = base[authority_end..].split(['?', '#']).next().unwrap_or("");
    let directory = &base_path[..base_path.rfind('/').map_or(0, |i| i + 1)];
    let directory = if directory.is_empty() { "/" } else { directory };
    format!("{origin}{}", normalize_path(&format!("{directory}{reference}")))
}

/// Removes `.` and `..` segments; keeps a query string as it is.
fn normalize_path(path: &str) -> String {
    let (path, query) = match path.find(['?', '#']) {
        Some(i) => path.split_at(i),
        None => (path, ""),
    };
    let mut segments: Vec<&str> = Vec::new();
    let parts: Vec<&str> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        match *part {
            "." => {}
            ".." => {
                segments.pop();
            }
            "" if index != 0 && index != parts.len() - 1 => {}
            other => segments.push(other),
        }
    }
    let mut out = segments.join("/");
    if !out.starts_with('/') {
        out.insert(0, '/');
    }
    if matches!(parts.last(), Some(&".") | Some(&"..")) && !out.ends_with('/') {
        out.push('/');
    }
    out.push_str(query);
    out
}

/// SOAP 1.1 envelope for `action` of `service_type` with the arguments in order (values escaped).
pub fn soap_envelope(service_type: &str, action: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(512);
    out.push_str(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>",
    );
    out.push_str("<u:");
    out.push_str(action);
    out.push_str(" xmlns:u=\"");
    out.push_str(&xml::escape(service_type));
    out.push_str("\">");
    for (name, value) in args {
        out.push('<');
        out.push_str(name);
        out.push('>');
        out.push_str(&xml::escape(value));
        out.push_str("</");
        out.push_str(name);
        out.push('>');
    }
    out.push_str("</u:");
    out.push_str(action);
    out.push_str("></s:Body></s:Envelope>");
    out
}

/// Value of the `SOAPACTION` header: `"<service_type>#<action>"` including the quotes.
pub fn soap_action_header(service_type: &str, action: &str) -> String {
    format!("\"{service_type}#{action}\"")
}

/// Output arguments of `<action>Response` by local name (unescaped), or the SOAP fault's UPnP error.
pub fn parse_soap_response(xml_text: &str, action: &str) -> Result<HashMap<String, String>, UpnpError> {
    let document = xml::parse(xml_text)?;
    let envelope = document.children.first().ok_or(UpnpError::Missing("Envelope"))?;
    let body = envelope.child("Body").ok_or(UpnpError::Missing("Body"))?;

    if let Some(fault) = body.child("Fault") {
        let upnp_error = fault.child("detail").and_then(|detail| detail.child("UPnPError"));
        let code = upnp_error
            .and_then(|e| e.child_text("errorCode"))
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let description = upnp_error
            .and_then(|e| e.child_text("errorDescription"))
            .or_else(|| fault.child_text("faultstring"))
            .unwrap_or_default();
        return Err(UpnpError::Fault { code, description });
    }

    let response_name = format!("{action}Response");
    let response = body
        .children
        .iter()
        .find(|node| node.name == response_name)
        .ok_or(UpnpError::Missing("ActionResponse"))?;
    Ok(response
        .children
        .iter()
        .map(|node| (node.name.clone(), node.text.trim().to_string()))
        .collect())
}

/// `http-get:*:<mime>:<DLNA flags>`: `DLNA.ORG_OP=01` (byte seek) when `seekable`, `00` otherwise;
/// `DLNA.ORG_CI=0`, streaming flags.
pub fn protocol_info_for(mime: &str, seekable: bool) -> String {
    let op = if seekable { "01" } else { "00" };
    format!(
        "http-get:*:{mime}:DLNA.ORG_OP={op};DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
    )
}

/// DIDL-Lite document for `item` (music track: title, artist, album, album art, `res` with
/// `protocolInfo` and `duration`) as plain XML. `soap_envelope` escapes it a second time as the
/// argument value, which is what devices expect.
pub fn didl_lite(item: &MediaItem, protocol_info: &str) -> String {
    let mut out = String::with_capacity(768);
    out.push_str(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" \
         xmlns:dlna=\"urn:schemas-dlna-org:metadata-1-0/\">\
         <item id=\"0\" parentID=\"-1\" restricted=\"1\">",
    );
    push_element(&mut out, "dc:title", &item.title);
    if let Some(artist) = item.artist.as_deref().filter(|a| !a.is_empty()) {
        push_element(&mut out, "upnp:artist", artist);
        push_element(&mut out, "dc:creator", artist);
    }
    if let Some(album) = item.album.as_deref().filter(|a| !a.is_empty()) {
        push_element(&mut out, "upnp:album", album);
    }
    if let Some(cover) = item.cover_url.as_deref() {
        push_element(&mut out, "upnp:albumArtURI", cover);
    }
    push_element(&mut out, "upnp:class", "object.item.audioItem.musicTrack");
    out.push_str("<res protocolInfo=\"");
    out.push_str(&xml::escape(protocol_info));
    out.push('"');
    if let Some(ms) = item.duration_ms {
        out.push_str(" duration=\"");
        out.push_str(&format_time(ms));
        out.push_str(".000\"");
    }
    out.push('>');
    out.push_str(&xml::escape(&item.url));
    out.push_str("</res></item></DIDL-Lite>");
    out
}

fn push_element(out: &mut String, name: &str, text: &str) {
    out.push('<');
    out.push_str(name);
    out.push('>');
    out.push_str(&xml::escape(text));
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

/// Audio MIME types (lowercase, deduplicated, in order) of the `http-get` entries of a
/// `GetProtocolInfo` `Sink` list.
pub fn sink_mimes(sink: &str) -> Vec<String> {
    let mut mimes: Vec<String> = Vec::new();
    for entry in sink.split(',') {
        let mut fields = entry.trim().splitn(4, ':');
        let (Some(protocol), Some(_network), Some(content_format)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        if !protocol.trim().eq_ignore_ascii_case("http-get") {
            continue;
        }
        let mime = content_format.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if mime.starts_with("audio/") && !mimes.contains(&mime) {
            mimes.push(mime);
        }
    }
    mimes
}

/// `H:MM:SS` (hours unpadded), e.g. `0:03:05`; milliseconds are dropped.
pub fn format_time(ms: u64) -> String {
    let seconds = ms / 1000;
    format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// Parses `H+:MM:SS[.F+]` (also `H:MM:SS.mmm`, and `F0/F1` fractions); `None` for empty strings and
/// `NOT_IMPLEMENTED`.
pub fn parse_time(text: &str) -> Option<u64> {
    let text = text.trim();
    let mut parts = text.split(':');
    let (hours, minutes, seconds) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let (seconds, fraction) = match seconds.split_once('.') {
        Some((seconds, fraction)) => (seconds, Some(fraction)),
        None => (seconds, None),
    };
    let hours = parse_digits(hours)?;
    let minutes = parse_digits(minutes)?;
    let seconds = parse_digits(seconds)?;
    let fraction_ms = match fraction {
        None => 0,
        Some(fraction) => match fraction.split_once('/') {
            Some((numerator, denominator)) => {
                let (numerator, denominator) = (parse_digits(numerator)?, parse_digits(denominator)?);
                if denominator == 0 {
                    return None;
                }
                numerator.checked_mul(1000)? / denominator
            }
            None => {
                if fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let mut digits = fraction.bytes().take(3).map(|b| u64::from(b - b'0')).collect::<Vec<_>>();
                digits.resize(3, 0);
                digits[0] * 100 + digits[1] * 10 + digits[2]
            }
        },
    };
    let total_seconds = hours.checked_mul(3600)?.checked_add(minutes.checked_mul(60)?)?.checked_add(seconds)?;
    total_seconds.checked_mul(1000)?.checked_add(fraction_ms)
}

fn parse_digits(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// A tiny XML tree: enough for device descriptions and SOAP bodies, matching by local name.
mod xml {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    use super::UpnpError;

    /// Nesting limit; real documents are far shallower, hostile ones must not exhaust the stack.
    const MAX_DEPTH: usize = 48;

    #[derive(Debug, Default)]
    pub struct Node {
        /// Local name (namespace prefix removed).
        pub name: String,
        /// Concatenated character data (entities resolved, CDATA included).
        pub text: String,
        pub children: Vec<Node>,
    }

    impl Node {
        pub fn child(&self, name: &str) -> Option<&Node> {
            self.children.iter().find(|node| node.name == name)
        }

        pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
            self.children.iter().filter(move |node| node.name == name)
        }

        /// Trimmed text of the first child called `name`; `None` if absent or empty.
        pub fn child_text(&self, name: &str) -> Option<String> {
            let text = self.child(name)?.text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
    }

    /// Parses `xml` into a synthetic root node whose children are the top-level elements.
    pub fn parse(xml: &str) -> Result<Node, UpnpError> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().expand_empty_elements = true;
        let mut stack = vec![Node::default()];
        loop {
            let event = reader.read_event().map_err(|err| UpnpError::Xml(err.to_string()))?;
            match event {
                Event::Start(start) => {
                    if stack.len() > MAX_DEPTH {
                        return Err(UpnpError::Xml("nesting is too deep".into()));
                    }
                    let name = start.local_name().as_ref().to_string();
                    stack.push(Node { name, ..Node::default() });
                }
                Event::End(_) => {
                    let node = stack.pop().ok_or_else(|| UpnpError::Xml("unbalanced tags".into()))?;
                    stack
                        .last_mut()
                        .ok_or_else(|| UpnpError::Xml("unbalanced tags".into()))?
                        .children
                        .push(node);
                }
                Event::Text(text) => current(&mut stack)?.text.push_str(&text.xml10_content()),
                Event::CData(data) => current(&mut stack)?.text.push_str(&data.xml10_content()),
                Event::GeneralRef(reference) => {
                    let node = current(&mut stack)?;
                    if let Ok(Some(ch)) = reference.resolve_char_ref() {
                        node.text.push(ch);
                    } else {
                        match &*reference {
                            "amp" => node.text.push('&'),
                            "lt" => node.text.push('<'),
                            "gt" => node.text.push('>'),
                            "quot" => node.text.push('"'),
                            "apos" => node.text.push('\''),
                            _ => {}
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        if stack.len() != 1 {
            return Err(UpnpError::Xml("unclosed element".into()));
        }
        Ok(stack.remove(0))
    }

    fn current(stack: &mut [Node]) -> Result<&mut Node, UpnpError> {
        stack.last_mut().ok_or_else(|| UpnpError::Xml("unbalanced tags".into()))
    }

    /// Escapes text for element content and attribute values; drops characters XML 1.0 forbids.
    pub fn escape(text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 8);
        for ch in text.chars() {
            match ch {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                '\t' | '\n' | '\r' => out.push(ch),
                c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
                c => out.push(c),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_RENDERER: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room</friendlyName>
    <manufacturer>Acme</manufacturer>
    <modelDescription>Network speaker</modelDescription>
    <modelName>Boom</modelName>
    <UDN>uuid:1234</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/RenderingControl/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <controlURL>/ConnectionManager/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/AVTransport/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Queue:1</serviceType>
        <controlURL>/Queue/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>"#;

    #[test]
    fn parses_a_root_renderer() {
        let d = parse_description(ROOT_RENDERER, "http://192.168.1.20:49152/description.xml").unwrap();
        assert_eq!(d.udn, "uuid:1234");
        assert_eq!(d.device_type, "urn:schemas-upnp-org:device:MediaRenderer:1");
        assert_eq!(d.friendly_name, "Living Room");
        assert_eq!(d.manufacturer.as_deref(), Some("Acme"));
        assert_eq!(d.model_name.as_deref(), Some("Boom"));
        assert_eq!(d.model_description.as_deref(), Some("Network speaker"));
        assert_eq!(
            d.av_transport,
            Some(ServiceInfo {
                service_type: AV_TRANSPORT.into(),
                control_url: "http://192.168.1.20:49152/AVTransport/control".into(),
            })
        );
        assert_eq!(d.rendering_control.unwrap().control_url, "http://192.168.1.20:49152/RenderingControl/control");
        assert_eq!(d.connection_manager.unwrap().control_url, "http://192.168.1.20:49152/ConnectionManager/control");
    }

    #[test]
    fn picks_the_embedded_renderer_of_another_root_device() {
        let xml = r#"<root><device>
            <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
            <friendlyName>Gateway</friendlyName><UDN>uuid:gw</UDN>
            <serviceList><service>
              <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/wrong</controlURL>
            </service></serviceList>
            <deviceList>
              <device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><UDN>uuid:wan</UDN>
                <deviceList><device>
                  <deviceType>urn:schemas-upnp-org:device:MediaRenderer:2</deviceType>
                  <friendlyName>Deep</friendlyName><UDN>uuid:deep</UDN>
                  <serviceList><service>
                    <serviceType>urn:schemas-upnp-org:service:AVTransport:3</serviceType><controlURL>av</controlURL>
                  </service></serviceList>
                </device></deviceList>
              </device>
            </deviceList>
        </device></root>"#;
        let d = parse_description(xml, "http://10.0.0.2:8000/dev/desc.xml").unwrap();
        assert_eq!(d.udn, "uuid:deep");
        assert_eq!(d.friendly_name, "Deep");
        let av = d.av_transport.unwrap();
        assert_eq!(av.service_type, "urn:schemas-upnp-org:service:AVTransport:3");
        assert_eq!(av.control_url, "http://10.0.0.2:8000/dev/av");
        assert!(d.rendering_control.is_none());
    }

    #[test]
    fn missing_renderer_is_reported() {
        let xml = r#"<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
            <friendlyName>NAS</friendlyName><UDN>uuid:nas</UDN></device></root>"#;
        assert!(matches!(parse_description(xml, "http://10.0.0.2/d.xml"), Err(UpnpError::Missing("MediaRenderer"))));
        assert!(matches!(parse_description("<root/>", "http://10.0.0.2/d.xml"), Err(UpnpError::Missing("device"))));
        assert!(matches!(parse_description("", "http://10.0.0.2/d.xml"), Err(UpnpError::Missing(_))));
        assert!(matches!(parse_description("<root><device>", "http://10.0.0.2/d.xml"), Err(UpnpError::Xml(_))));
    }

    #[test]
    fn url_base_takes_precedence_for_relative_urls() {
        let xml = r#"<root><URLBase>http://192.168.1.50:9000</URLBase><device>
            <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>X</friendlyName><UDN>uuid:x</UDN>
            <serviceList>
              <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/av</controlURL></service>
              <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>rc</controlURL></service>
              <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
                <controlURL>http://192.168.1.51:1234/cm</controlURL></service>
            </serviceList></device></root>"#;
        let d = parse_description(xml, "http://192.168.1.20:49152/x/description.xml").unwrap();
        assert_eq!(d.av_transport.unwrap().control_url, "http://192.168.1.50:9000/upnp/av");
        assert_eq!(d.rendering_control.unwrap().control_url, "http://192.168.1.50:9000/rc");
        assert_eq!(d.connection_manager.unwrap().control_url, "http://192.168.1.51:1234/cm");
    }

    #[test]
    fn resolves_relative_urls() {
        let base = "http://10.0.0.2:8080/dev/desc.xml?x=1";
        assert_eq!(resolve_url(base, "http://other:1/a"), "http://other:1/a");
        assert_eq!(resolve_url(base, "HTTPS://other/a"), "HTTPS://other/a");
        assert_eq!(resolve_url(base, "/a/b"), "http://10.0.0.2:8080/a/b");
        assert_eq!(resolve_url(base, "a/b"), "http://10.0.0.2:8080/dev/a/b");
        assert_eq!(resolve_url(base, "./a"), "http://10.0.0.2:8080/dev/a");
        assert_eq!(resolve_url(base, "../a"), "http://10.0.0.2:8080/a");
        assert_eq!(resolve_url(base, "//10.0.0.3/a"), "http://10.0.0.3/a");
        assert_eq!(resolve_url("http://10.0.0.2:8080", "a"), "http://10.0.0.2:8080/a");
        assert_eq!(resolve_url("http://10.0.0.2:8080", "/a?b=1"), "http://10.0.0.2:8080/a?b=1");
        assert_eq!(resolve_url("http://10.0.0.2/", "a"), "http://10.0.0.2/a");
        assert_eq!(resolve_url("http://10.0.0.2/base/", "a"), "http://10.0.0.2/base/a");
        assert_eq!(resolve_url("http://10.0.0.2?q=1", "a"), "http://10.0.0.2/a");
        assert_eq!(resolve_url("http://[fe80::1]:80/d/x.xml", "c"), "http://[fe80::1]:80/d/c");
    }

    #[test]
    fn description_handles_prefixes_entities_and_cdata() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:root xmlns:d="urn:schemas-upnp-org:device-1-0" xmlns:x="urn:other">
  <d:device>
    <d:deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</d:deviceType>
    <d:friendlyName>Tom &amp; Jerry&apos;s &lt;Speaker&gt; &#228;</d:friendlyName>
    <d:manufacturer><![CDATA[R&D <Labs>]]></d:manufacturer>
    <d:UDN>uuid:p</d:UDN>
    <x:modelName>Prefixes are ignored</x:modelName>
    <d:serviceList><d:service>
      <d:serviceType>urn:schemas-upnp-org:service:AVTransport:1</d:serviceType>
      <d:controlURL>/ctl?a=1&amp;b=2</d:controlURL>
    </d:service></d:serviceList>
  </d:device>
</d:root>"#;
        let d = parse_description(xml, "http://1.2.3.4:5/d.xml").unwrap();
        assert_eq!(d.friendly_name, "Tom & Jerry's <Speaker> \u{e4}");
        assert_eq!(d.manufacturer.as_deref(), Some("R&D <Labs>"));
        assert_eq!(d.model_name.as_deref(), Some("Prefixes are ignored"));
        assert_eq!(d.av_transport.unwrap().control_url, "http://1.2.3.4:5/ctl?a=1&b=2");
    }

    #[test]
    fn description_without_friendly_name_falls_back() {
        let xml = r#"<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
            <modelName>M1</modelName><UDN>uuid:m</UDN></device></root>"#;
        assert_eq!(parse_description(xml, "http://1.2.3.4/d").unwrap().friendly_name, "M1");
    }

    #[test]
    fn deep_nesting_is_refused() {
        let xml = format!("{}{}", "<a>".repeat(5000), "</a>".repeat(5000));
        assert!(matches!(xml::parse(&xml), Err(UpnpError::Xml(_))));
    }

    #[test]
    fn soap_envelope_escapes_arguments() {
        let envelope = soap_envelope(AV_TRANSPORT, "SetAVTransportURI", &[("InstanceID", "0"), ("CurrentURI", "a<&>\"'b")]);
        assert!(envelope.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope"));
        assert!(envelope.contains("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\""));
        assert!(envelope.contains("<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"));
        assert!(envelope.contains("<InstanceID>0</InstanceID>"));
        assert!(envelope.contains("<CurrentURI>a&lt;&amp;&gt;&quot;&apos;b</CurrentURI>"));
        assert!(envelope.ends_with("</u:SetAVTransportURI></s:Body></s:Envelope>"));
        // Well-formed, and the value round-trips.
        let parsed = xml::parse(&envelope).unwrap();
        let action = parsed.children[0].child("Body").unwrap().child("SetAVTransportURI").unwrap();
        assert_eq!(action.child("CurrentURI").unwrap().text, "a<&>\"'b");
    }

    #[test]
    fn soap_envelope_without_arguments_and_forbidden_characters() {
        let envelope = soap_envelope(CONNECTION_MANAGER, "GetProtocolInfo", &[]);
        assert!(envelope.contains("<u:GetProtocolInfo xmlns:u=\"urn:schemas-upnp-org:service:ConnectionManager:1\"></u:GetProtocolInfo>"));
        let envelope = soap_envelope(AV_TRANSPORT, "X", &[("A", "a\u{0}b\u{8}c\td")]);
        assert!(envelope.contains("<A>abc\td</A>"));
    }

    #[test]
    fn soap_action_header_is_quoted() {
        assert_eq!(
            soap_action_header(AV_TRANSPORT, "Play"),
            "\"urn:schemas-upnp-org:service:AVTransport:1#Play\""
        );
    }

    #[test]
    fn parses_a_soap_response() {
        let xml = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
 <s:Body>
  <u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
   <Track>1</Track>
   <TrackDuration>0:03:05</TrackDuration>
   <TrackMetaData>&lt;DIDL-Lite&gt;&amp;amp;&lt;/DIDL-Lite&gt;</TrackMetaData>
   <TrackURI>http://h/a?x=1&amp;y=2</TrackURI>
   <RelTime> 0:00:12 </RelTime>
   <AbsTime/>
  </u:GetPositionInfoResponse>
 </s:Body>
</s:Envelope>"#;
        let map = parse_soap_response(xml, "GetPositionInfo").unwrap();
        assert_eq!(map["TrackDuration"], "0:03:05");
        assert_eq!(map["TrackMetaData"], "<DIDL-Lite>&amp;</DIDL-Lite>");
        assert_eq!(map["TrackURI"], "http://h/a?x=1&y=2");
        assert_eq!(map["RelTime"], "0:00:12");
        assert_eq!(map["AbsTime"], "");
        assert_eq!(map.len(), 6);
    }

    #[test]
    fn empty_response_is_an_empty_map() {
        let xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
            <u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>"#;
        assert!(parse_soap_response(xml, "Play").unwrap().is_empty());
        assert!(matches!(parse_soap_response(xml, "Stop"), Err(UpnpError::Missing(_))));
    }

    #[test]
    fn parses_a_soap_fault() {
        let xml = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
 <s:Body><s:Fault>
   <faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
   <detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
     <errorCode>701</errorCode><errorDescription>Transition not available</errorDescription>
   </UPnPError></detail>
 </s:Fault></s:Body>
</s:Envelope>"#;
        match parse_soap_response(xml, "Play") {
            Err(UpnpError::Fault { code, description }) => {
                assert_eq!(code, 701);
                assert_eq!(description, "Transition not available");
            }
            other => panic!("expected a fault, got {other:?}"),
        }
    }

    #[test]
    fn fault_without_details_has_code_zero() {
        let xml = r#"<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultstring>boom</faultstring></s:Fault></s:Body></s:Envelope>"#;
        assert!(matches!(
            parse_soap_response(xml, "Play"),
            Err(UpnpError::Fault { code: 0, description }) if description == "boom"
        ));
    }

    #[test]
    fn garbage_soap_is_an_error() {
        assert!(parse_soap_response("not xml at all", "Play").is_err());
        assert!(parse_soap_response("<a><b></a>", "Play").is_err());
        assert!(parse_soap_response("<html><body>Error</body></html>", "Play").is_err());
    }

    #[test]
    fn protocol_info_flags() {
        assert_eq!(
            protocol_info_for("audio/flac", true),
            "http-get:*:audio/flac:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
        );
        assert!(protocol_info_for("audio/mpeg", false).contains("DLNA.ORG_OP=00;"));
    }

    fn item() -> MediaItem {
        MediaItem {
            url: "http://192.168.1.2:4000/s/tok?a=1&b=2".into(),
            mime: "audio/flac".into(),
            title: "Rock & Roll <Live>".into(),
            artist: Some("AC/DC \"Band\"".into()),
            album: Some("It's".into()),
            cover_url: Some("http://192.168.1.2:4000/c/tok?size=300&x=y".into()),
            duration_ms: Some(185_999),
            seekable: true,
        }
    }

    #[test]
    fn didl_lite_is_well_formed_and_escaped() {
        let info = protocol_info_for("audio/flac", true);
        let didl = didl_lite(&item(), &info);
        assert!(didl.contains("<dc:title>Rock &amp; Roll &lt;Live&gt;</dc:title>"));
        assert!(didl.contains("<upnp:artist>AC/DC &quot;Band&quot;</upnp:artist>"));
        assert!(didl.contains("<dc:creator>AC/DC &quot;Band&quot;</dc:creator>"));
        assert!(didl.contains("<upnp:album>It&apos;s</upnp:album>"));
        assert!(didl.contains("<upnp:albumArtURI>http://192.168.1.2:4000/c/tok?size=300&amp;x=y</upnp:albumArtURI>"));
        assert!(didl.contains("<upnp:class>object.item.audioItem.musicTrack</upnp:class>"));
        assert!(didl.contains("duration=\"0:03:05.000\""));
        assert!(didl.contains(">http://192.168.1.2:4000/s/tok?a=1&amp;b=2</res>"));
        assert!(didl.contains("<item id=\"0\" parentID=\"-1\" restricted=\"1\">"));

        let tree = xml::parse(&didl).unwrap();
        let didl_node = &tree.children[0];
        assert_eq!(didl_node.name, "DIDL-Lite");
        let node = didl_node.child("item").unwrap();
        assert_eq!(node.child("title").unwrap().text, "Rock & Roll <Live>");
        assert_eq!(node.child("res").unwrap().text, "http://192.168.1.2:4000/s/tok?a=1&b=2");
    }

    #[test]
    fn didl_lite_omits_missing_parts_and_is_escaped_again_by_the_envelope() {
        let mut minimal = item();
        minimal.artist = None;
        minimal.album = None;
        minimal.cover_url = None;
        minimal.duration_ms = None;
        let didl = didl_lite(&minimal, "http-get:*:audio/flac:*");
        assert!(!didl.contains("upnp:artist") && !didl.contains("upnp:album") && !didl.contains("albumArtURI"));
        assert!(!didl.contains("duration="));

        let envelope = soap_envelope(AV_TRANSPORT, "SetAVTransportURI", &[("CurrentURIMetaData", &didl_lite(&item(), "p"))]);
        assert!(envelope.contains("&lt;dc:title&gt;Rock &amp;amp; Roll &amp;lt;Live&amp;gt;&lt;/dc:title&gt;"));
    }

    #[test]
    fn sink_mimes_keeps_audio_http_get_entries() {
        let sink = "http-get:*:audio/mpeg:DLNA.ORG_PN=MP3, http-get:*:audio/FLAC:*,http-get:*:audio/L16;rate=44100;channels=2:DLNA.ORG_PN=LPCM,\
            http-get:*:video/mp4:*,rtsp-rtp-udp:*:audio/mpeg:*,http-get:*:audio/flac:*,http-get:*:*:*,garbage,, http-get:*:audio/x-wav";
        assert_eq!(sink_mimes(sink), vec!["audio/mpeg", "audio/flac", "audio/l16", "audio/x-wav"]);
        assert!(sink_mimes("").is_empty());
    }

    #[test]
    fn formats_time() {
        assert_eq!(format_time(0), "0:00:00");
        assert_eq!(format_time(999), "0:00:00");
        assert_eq!(format_time(185_000), "0:03:05");
        assert_eq!(format_time(3_600_000), "1:00:00");
        assert_eq!(format_time(100 * 3_600_000 + 61_000), "100:01:01");
    }

    #[test]
    fn parses_time() {
        assert_eq!(parse_time("0:00:00"), Some(0));
        assert_eq!(parse_time("0:03:05"), Some(185_000));
        assert_eq!(parse_time("00:03:05"), Some(185_000));
        assert_eq!(parse_time("1:02:03"), Some(3_723_000));
        assert_eq!(parse_time("0:00:01.500"), Some(1500));
        assert_eq!(parse_time("0:00:01.5"), Some(1500));
        assert_eq!(parse_time("0:00:01.123456"), Some(1123));
        assert_eq!(parse_time("0:00:01.1/2"), Some(1500));
        assert_eq!(parse_time(" 10:00:00.000 "), Some(36_000_000));
        assert_eq!(parse_time("100:00:00"), Some(360_000_000));
    }

    #[test]
    fn parse_time_rejects_junk() {
        for text in [
            "", "NOT_IMPLEMENTED", "abc", "1:2", "1:2:3:4", "-0:00:01", "+0:00:01", "0:00:01.", "0:00:01.x", "0:00:01.1/0", "::",
            "0:0a:01", "99999999999999999999:00:00", "18446744073709551615:00:00",
        ] {
            assert_eq!(parse_time(text), None, "{text:?}");
        }
    }

    #[test]
    fn time_round_trips() {
        for ms in [0, 1000, 59_000, 61_000, 3_599_000, 7_325_000] {
            assert_eq!(parse_time(&format_time(ms)), Some(ms));
        }
    }
}

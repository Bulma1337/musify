//! SSDP (UPnP discovery): M-SEARCH requests and their responses. Pure functions; the sockets live
//! in `discovery.rs`.

use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};

pub const SSDP_ADDR: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
pub const MEDIA_RENDERER_ST: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SsdpResponse {
    /// URL of the device description.
    pub location: String,
    pub st: Option<String>,
    pub usn: Option<String>,
    pub server: Option<String>,
}

/// The M-SEARCH request for `st` with `MX: mx_secs` (CRLF line endings, empty line at the end).
pub fn msearch_request(_st: &str, _mx_secs: u8) -> String {
    todo!("ssdp::msearch_request")
}

/// Parses a unicast M-SEARCH response (`HTTP/1.1 200 OK`) or a `NOTIFY * HTTP/1.1` with
/// `NTS: ssdp:alive`. Header names are case-insensitive; `None` without a `LOCATION`.
pub fn parse_response(_datagram: &[u8]) -> Option<SsdpResponse> {
    todo!("ssdp::parse_response")
}

/// The description URL is only followed when it is plain `http`, its host is an IP literal equal to
/// the responder's address `from`, and it has no userinfo. Anything else could point Musify at other
/// hosts.
pub fn location_matches_sender(_location: &str, _from: IpAddr) -> bool {
    todo!("ssdp::location_matches_sender")
}

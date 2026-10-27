//! SSDP (UPnP discovery): M-SEARCH requests and their responses. Pure functions; the sockets live
//! in `discovery.rs`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddrV4};

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
pub fn msearch_request(st: &str, mx_secs: u8) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: 239.255.255.250:1900\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: {mx_secs}\r\n\
         ST: {st}\r\n\
         USER-AGENT: Musify UPnP/1.1\r\n\
         \r\n"
    )
}

/// Parses a unicast M-SEARCH response (`HTTP/1.1 200 OK`) or a `NOTIFY * HTTP/1.1` with
/// `NTS: ssdp:alive`. Header names are case-insensitive; `None` without a `LOCATION`.
pub fn parse_response(datagram: &[u8]) -> Option<SsdpResponse> {
    let text = std::str::from_utf8(datagram).ok()?;
    let mut lines = text.split('\n').map(|line| line.trim_end_matches('\r'));
    let start = lines.next()?.trim();

    let is_notify = if is_ok_status_line(start) {
        false
    } else if is_notify_line(start) {
        true
    } else {
        return None;
    };

    let (mut location, mut st, mut nt, mut nts, mut usn, mut server) = (None, None, None, None, None, None);
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let slot = match name.trim().to_ascii_lowercase().as_str() {
            "location" => &mut location,
            "st" => &mut st,
            "nt" => &mut nt,
            "nts" => &mut nts,
            "usn" => &mut usn,
            "server" => &mut server,
            _ => continue,
        };
        *slot = Some(value.to_string());
    }

    if is_notify && !nts.as_deref().is_some_and(|v| v.eq_ignore_ascii_case("ssdp:alive")) {
        return None;
    }
    Some(SsdpResponse { location: location?, st: if is_notify { nt } else { st }, usn, server })
}

fn is_ok_status_line(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    matches!(
        (parts.next(), parts.next()),
        (Some(version), Some("200")) if version.to_ascii_uppercase().starts_with("HTTP/1.")
    )
}

fn is_notify_line(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(method), Some("*"), Some(version))
            if method.eq_ignore_ascii_case("NOTIFY") && version.to_ascii_uppercase().starts_with("HTTP/1.")
    )
}

/// The description URL is only followed when it is plain `http`, its host is an IP literal equal to
/// the responder's address `from`, and it has no userinfo. Anything else could point Musify at other
/// hosts.
pub fn location_matches_sender(location: &str, from: IpAddr) -> bool {
    host_of_http_url(location.trim()).is_some_and(|host| host.to_canonical() == from.to_canonical())
}

/// The IP literal host of an `http://` URL; `None` for other schemes, userinfo, hostnames or a
/// malformed port. Written by hand because the rest of the crate needs no URL parser.
fn host_of_http_url(url: &str) -> Option<IpAddr> {
    let scheme = url.get(..7)?;
    if !scheme.eq_ignore_ascii_case("http://") {
        return None;
    }
    let authority = url[7..].split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        let port = if after.is_empty() { None } else { Some(after.strip_prefix(':')?) };
        (IpAddr::V6(host.parse::<Ipv6Addr>().ok()?), port)
    } else {
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        (IpAddr::V4(host.parse::<Ipv4Addr>().ok()?), port)
    };
    if let Some(port) = port
        && (!port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u16>().is_err())
    {
        return None;
    }
    Some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msearch_has_the_required_headers() {
        let request = msearch_request(MEDIA_RENDERER_ST, 2);
        assert_eq!(
            request,
            "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n\
             ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSER-AGENT: Musify UPnP/1.1\r\n\r\n"
        );
        assert!(!request.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn parses_a_search_response() {
        let datagram = b"HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\n\
            LOCATION: http://192.168.1.20:49152/description.xml\r\n\
            SERVER: Linux/4.9 UPnP/1.0 Renderer/1.2\r\n\
            ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\
            USN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
        let response = parse_response(datagram).unwrap();
        assert_eq!(response.location, "http://192.168.1.20:49152/description.xml");
        assert_eq!(response.st.as_deref(), Some("urn:schemas-upnp-org:device:MediaRenderer:1"));
        assert_eq!(response.usn.as_deref(), Some("uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1"));
        assert_eq!(response.server.as_deref(), Some("Linux/4.9 UPnP/1.0 Renderer/1.2"));
    }

    #[test]
    fn header_names_are_case_insensitive_and_values_trimmed() {
        let datagram = b"HTTP/1.1 200 OK\r\nlocation:   http://10.0.0.5:80/d.xml  \r\nSt:urn:x\r\nusn : uuid:1\r\n\r\n";
        let response = parse_response(datagram).unwrap();
        assert_eq!(response.location, "http://10.0.0.5:80/d.xml");
        assert_eq!(response.st.as_deref(), Some("urn:x"));
        assert_eq!(response.usn.as_deref(), Some("uuid:1"));
        assert_eq!(response.server, None);
    }

    #[test]
    fn tolerates_lf_only_line_endings() {
        let datagram = b"HTTP/1.1 200 OK\nLOCATION: http://10.0.0.5/d.xml\nST: urn:x\n\n";
        assert_eq!(parse_response(datagram).unwrap().location, "http://10.0.0.5/d.xml");
    }

    #[test]
    fn parses_notify_alive_with_nt_as_st() {
        let datagram = b"NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\
            NTS: ssdp:alive\r\nLOCATION: http://192.168.1.9:8080/desc\r\nUSN: uuid:9\r\nSERVER: x\r\n\r\n";
        let response = parse_response(datagram).unwrap();
        assert_eq!(response.location, "http://192.168.1.9:8080/desc");
        assert_eq!(response.st.as_deref(), Some("urn:schemas-upnp-org:device:MediaRenderer:1"));
    }

    #[test]
    fn ignores_byebye_and_notify_without_nts() {
        let byebye = b"NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nNTS: ssdp:byebye\r\nUSN: uuid:9\r\nLOCATION: http://1.2.3.4/d\r\n\r\n";
        assert_eq!(parse_response(byebye), None);
        let no_nts = b"NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nLOCATION: http://1.2.3.4/d\r\n\r\n";
        assert_eq!(parse_response(no_nts), None);
    }

    #[test]
    fn ignores_responses_without_location_and_junk() {
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nST: urn:x\r\n\r\n"), None);
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nLOCATION:\r\n\r\n"), None);
        assert_eq!(parse_response(b"HTTP/1.1 404 Not Found\r\nLOCATION: http://1.2.3.4/d\r\n\r\n"), None);
        assert_eq!(parse_response(b"M-SEARCH * HTTP/1.1\r\nLOCATION: http://1.2.3.4/d\r\n\r\n"), None);
        assert_eq!(parse_response(b"garbage"), None);
        assert_eq!(parse_response(b""), None);
        assert_eq!(parse_response(&[0xff, 0xfe, 0x00, 0x80]), None);
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nLOCATION: http://1.2.3.4/\xff\r\n\r\n"), None);
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn location_must_point_at_the_sender() {
        let from = ip("192.168.1.20");
        assert!(location_matches_sender("http://192.168.1.20:49152/description.xml", from));
        assert!(location_matches_sender("http://192.168.1.20/description.xml", from));
        assert!(location_matches_sender("http://192.168.1.20", from));
        assert!(location_matches_sender("HTTP://192.168.1.20:80/x", from));
        assert!(location_matches_sender("http://192.168.1.20?x=1", from));
    }

    #[test]
    fn location_rejects_other_hosts_and_schemes() {
        let from = ip("192.168.1.20");
        assert!(!location_matches_sender("http://192.168.1.21:49152/d.xml", from));
        assert!(!location_matches_sender("http://evil.example.com/d.xml", from));
        assert!(!location_matches_sender("http://localhost/d.xml", from));
        assert!(!location_matches_sender("https://192.168.1.20/d.xml", from));
        assert!(!location_matches_sender("ftp://192.168.1.20/d.xml", from));
        assert!(!location_matches_sender("192.168.1.20/d.xml", from));
        assert!(!location_matches_sender("", from));
        assert!(!location_matches_sender("http://", from));
        assert!(!location_matches_sender("http://192.168.1.20:/d.xml", from));
        assert!(!location_matches_sender("http://192.168.1.20:99999/d.xml", from));
        assert!(!location_matches_sender("http://192.168.1.20:80:80/d.xml", from));
        assert!(!location_matches_sender("http://192.168.1.2/d.xml", from));
    }

    #[test]
    fn location_rejects_spoofed_authorities() {
        let from = ip("192.168.1.20");
        assert!(!location_matches_sender("http://192.168.1.20@evil.example.com/d.xml", from));
        assert!(!location_matches_sender("http://user@192.168.1.20/d.xml", from));
        assert!(!location_matches_sender("http://user:pw@192.168.1.20:80/d.xml", from));
        assert!(!location_matches_sender("http://evil.example.com/192.168.1.20", from));
        assert!(!location_matches_sender("http://evil.example.com#@192.168.1.20/", from));
        assert!(!location_matches_sender("http://192.168.1.20.evil.example.com/d.xml", from));
        assert!(!location_matches_sender("http://192.168.1.20\\@evil.example.com/", from));
    }

    #[test]
    fn location_handles_ipv6_literals() {
        let from = ip("fe80::1234");
        assert!(location_matches_sender("http://[fe80::1234]:8080/d.xml", from));
        assert!(location_matches_sender("http://[FE80:0:0:0:0:0:0:1234]/d.xml", from));
        assert!(!location_matches_sender("http://[fe80::1235]:8080/d.xml", from));
        assert!(!location_matches_sender("http://fe80::1234/d.xml", from));
        assert!(!location_matches_sender("http://[fe80::1234/d.xml", from));
        assert!(!location_matches_sender("http://[fe80::1234]x/d.xml", from));
        assert!(!location_matches_sender("http://[fe80::1234]@evil.example.com/", from));
        assert!(!location_matches_sender("http://[fe80::1234]:/d.xml", from));
        assert!(!location_matches_sender("http://[fe80::1234]:8080/d.xml", ip("192.168.1.20")));
    }

    #[test]
    fn location_accepts_ipv4_mapped_senders() {
        assert!(location_matches_sender("http://192.168.1.20/d.xml", ip("::ffff:192.168.1.20")));
    }
}

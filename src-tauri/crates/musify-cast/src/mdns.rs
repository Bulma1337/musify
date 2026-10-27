//! Multicast DNS (RFC 6762/6763): one-shot PTR queries and parsing the answers. Pure functions; the
//! sockets live in `discovery.rs`.

use std::net::{Ipv4Addr, SocketAddrV4};

pub const MDNS_ADDR: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(224, 0, 0, 251), 5353);
/// Service type of Cast devices.
pub const CAST_SERVICE: &str = "_googlecast._tcp.local";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceInstance {
    /// Full instance name, e.g. `Kitchen-abc123._googlecast._tcp.local`.
    pub instance: String,
    /// SRV target host, if the packet carries the SRV record.
    pub host: Option<String>,
    pub port: Option<u16>,
    /// A records of the SRV target found in the same packet.
    pub addrs: Vec<Ipv4Addr>,
    /// TXT key/value pairs (keys lowercase; entries without `=` get an empty value).
    pub txt: Vec<(String, String)>,
}

/// A DNS query packet with one PTR question for `service` (class IN, the QU bit set when
/// `unicast_response`).
pub fn build_query(_service: &str, _id: u16, _unicast_response: bool) -> Vec<u8> {
    todo!("mdns::build_query")
}

/// Instances of `service` in a response packet (answers and additional records, with name
/// compression). Malformed packets give an empty list, never a panic.
pub fn parse_response(_packet: &[u8], _service: &str) -> Vec<ServiceInstance> {
    todo!("mdns::parse_response")
}

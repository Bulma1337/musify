//! Multicast DNS (RFC 6762/6763): one-shot PTR queries and parsing the answers. Pure functions; the
//! sockets live in `discovery.rs`.

use std::net::{Ipv4Addr, SocketAddrV4};

pub const MDNS_ADDR: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(224, 0, 0, 251), 5353);
/// Service type of Cast devices.
pub const CAST_SERVICE: &str = "_googlecast._tcp.local";

const HEADER_LEN: usize = 12;
const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_TXT: u16 = 16;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;
/// QU bit in a question: asks for a unicast reply.
const CLASS_QU: u16 = 0x8000;
/// RFC 1035 limit for a whole name in dotted form.
const MAX_NAME_LEN: usize = 255;
const MAX_LABEL_LEN: usize = 63;
/// Real names compress through one or two pointers; anything deeper is hostile.
const MAX_POINTER_JUMPS: usize = 16;

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
pub fn build_query(service: &str, id: u16, unicast_response: bool) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_LEN + service.len() + 6);
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&[0; 6]);
    for label in service.split('.').filter(|l| !l.is_empty()) {
        let bytes = label.as_bytes();
        let len = bytes.len().min(MAX_LABEL_LEN);
        packet.push(len as u8);
        packet.extend_from_slice(&bytes[..len]);
    }
    packet.push(0);
    packet.extend_from_slice(&TYPE_PTR.to_be_bytes());
    let class = if unicast_response {
        CLASS_IN | CLASS_QU
    } else {
        CLASS_IN
    };
    packet.extend_from_slice(&class.to_be_bytes());
    packet
}

enum Data {
    Ptr(String),
    Srv { host: String, port: u16 },
    Txt(Vec<(String, String)>),
    A(Ipv4Addr),
}

struct Record {
    owner: String,
    data: Data,
}

/// Instances of `service` in a response packet (answers and additional records, with name
/// compression). Malformed packets give an empty list, never a panic.
pub fn parse_response(packet: &[u8], service: &str) -> Vec<ServiceInstance> {
    let mut records = Vec::new();
    // A truncated packet still yields the records before the cut.
    let _ = collect_records(packet, &mut records);

    let service = normalize(service);
    let suffix = format!(".{service}");
    let mut instances: Vec<ServiceInstance> = Vec::new();

    for record in &records {
        if let Data::Ptr(target) = &record.data
            && normalize(&record.owner) == service
        {
            instance_index(&mut instances, target);
        }
    }
    for record in &records {
        if matches!(record.data, Data::Srv { .. } | Data::Txt(_)) && normalize(&record.owner).ends_with(&suffix) {
            instance_index(&mut instances, &record.owner);
        }
    }

    for record in &records {
        let Some(index) = instances
            .iter()
            .position(|i| normalize(&i.instance) == normalize(&record.owner))
        else {
            continue;
        };
        let instance = &mut instances[index];
        match &record.data {
            Data::Srv { host, port } if instance.host.is_none() => {
                instance.host = Some(host.clone());
                instance.port = Some(*port);
            }
            Data::Txt(entries) => instance.txt.extend(entries.iter().cloned()),
            _ => {}
        }
    }

    for instance in &mut instances {
        let Some(host) = instance.host.as_deref().map(normalize) else {
            continue;
        };
        for record in &records {
            if let Data::A(addr) = record.data
                && normalize(&record.owner) == host
                && !instance.addrs.contains(&addr)
            {
                instance.addrs.push(addr);
            }
        }
    }
    instances
}

/// Lowercase without the trailing dot, for comparing names.
fn normalize(name: &str) -> String {
    name.trim_end_matches('.').to_ascii_lowercase()
}

fn instance_index(instances: &mut Vec<ServiceInstance>, name: &str) -> usize {
    let wanted = normalize(name);
    if let Some(index) = instances.iter().position(|i| normalize(&i.instance) == wanted) {
        return index;
    }
    instances.push(ServiceInstance {
        instance: name.trim_end_matches('.').to_string(),
        ..ServiceInstance::default()
    });
    instances.len() - 1
}

fn u16_at(packet: &[u8], pos: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *packet.get(pos)?,
        *packet.get(pos.checked_add(1)?)?,
    ]))
}

/// Reads the records of `packet` into `out` until the first framing error (`None`).
fn collect_records(packet: &[u8], out: &mut Vec<Record>) -> Option<()> {
    if packet.len() < HEADER_LEN {
        return None;
    }
    let questions = u16_at(packet, 4)?;
    let records = usize::from(u16_at(packet, 6)?) + usize::from(u16_at(packet, 8)?) + usize::from(u16_at(packet, 10)?);

    let mut pos = HEADER_LEN;
    for _ in 0..questions {
        let (_, next) = read_name(packet, pos)?;
        pos = next.checked_add(4)?;
        if pos > packet.len() {
            return None;
        }
    }

    for _ in 0..records {
        let (owner, next) = read_name(packet, pos)?;
        let rtype = u16_at(packet, next)?;
        // Class (next + 2) carries the cache-flush bit and is not needed; TTL is next + 4.
        let rdlen = usize::from(u16_at(packet, next.checked_add(8)?)?);
        let start = next.checked_add(10)?;
        let end = start.checked_add(rdlen)?;
        let rdata = packet.get(start..end)?;
        pos = end;
        if let Some(data) = parse_rdata(packet, rtype, start, rdata) {
            out.push(Record { owner, data });
        }
    }
    Some(())
}

/// `None` for record types we don't use and for malformed RDATA (the record is skipped).
fn parse_rdata(packet: &[u8], rtype: u16, start: usize, rdata: &[u8]) -> Option<Data> {
    match rtype {
        TYPE_PTR => {
            let (name, end) = read_name(packet, start)?;
            (end <= start + rdata.len()).then_some(Data::Ptr(name))
        }
        TYPE_SRV => {
            let port = u16_at(rdata, 4)?;
            let (host, end) = read_name(packet, start + 6)?;
            (end <= start + rdata.len()).then_some(Data::Srv { host, port })
        }
        TYPE_TXT => Some(Data::Txt(parse_txt(rdata))),
        TYPE_A => {
            let octets: [u8; 4] = rdata.try_into().ok()?;
            Some(Data::A(Ipv4Addr::from(octets)))
        }
        _ => None,
    }
}

fn parse_txt(rdata: &[u8]) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut pos = 0;
    while let Some(&len) = rdata.get(pos) {
        let Some(text) = rdata.get(pos + 1..pos + 1 + usize::from(len)) else {
            break;
        };
        pos += 1 + usize::from(len);
        if text.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(text);
        let (key, value) = text.split_once('=').unwrap_or((&text, ""));
        entries.push((key.to_ascii_lowercase(), value.to_string()));
    }
    entries
}

/// Reads a possibly compressed name starting at `start`. Returns the dotted name and the position
/// right after it in the original stream (after the first pointer, if any).
///
/// Pointers must point backwards, the number of jumps and the name length are bounded, so hostile
/// packets can't loop or blow up.
fn read_name(packet: &[u8], start: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    let mut pos = start;
    let mut end = None;
    let mut jumps = 0;
    loop {
        let len = *packet.get(pos)?;
        match len & 0xC0 {
            0x00 if len == 0 => return Some((name, end.unwrap_or(pos + 1))),
            0x00 => {
                let len = usize::from(len);
                let label = packet.get(pos + 1..pos + 1 + len)?;
                if !name.is_empty() {
                    name.push('.');
                }
                name.push_str(&String::from_utf8_lossy(label));
                if name.len() > MAX_NAME_LEN {
                    return None;
                }
                pos += 1 + len;
            }
            0xC0 => {
                let low = *packet.get(pos + 1)?;
                let target = (usize::from(len & 0x3F) << 8) | usize::from(low);
                if target >= pos || jumps >= MAX_POINTER_JUMPS {
                    return None;
                }
                jumps += 1;
                if end.is_none() {
                    end = Some(pos + 2);
                }
                pos = target;
            }
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_labels(buf: &mut Vec<u8>, labels: &[&str]) {
        for label in labels {
            buf.push(label.len() as u8);
            buf.extend_from_slice(label.as_bytes());
        }
    }

    fn push_pointer(buf: &mut Vec<u8>, target: usize) {
        buf.extend_from_slice(&(0xC000u16 | target as u16).to_be_bytes());
    }

    /// Writes type, class, TTL and RDLENGTH around whatever `rdata` appends.
    fn push_record(buf: &mut Vec<u8>, rtype: u16, class: u16, rdata: impl FnOnce(&mut Vec<u8>)) {
        buf.extend_from_slice(&rtype.to_be_bytes());
        buf.extend_from_slice(&class.to_be_bytes());
        buf.extend_from_slice(&120u32.to_be_bytes());
        let len_at = buf.len();
        buf.extend_from_slice(&[0, 0]);
        rdata(buf);
        let len = (buf.len() - len_at - 2) as u16;
        buf[len_at..len_at + 2].copy_from_slice(&len.to_be_bytes());
    }

    fn txt_string(buf: &mut Vec<u8>, text: &str) {
        buf.push(text.len() as u8);
        buf.extend_from_slice(text.as_bytes());
    }

    /// PTR in the answers; SRV, TXT and A (cache-flush bit set) as additional records, all names
    /// compressed against each other.
    fn cast_response() -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&[0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);

        let service_at = p.len();
        push_labels(&mut p, &["_googlecast", "_tcp", "local"]);
        p.push(0);
        let local_at = service_at + 1 + 11 + 1 + 4;

        let mut instance_at = 0;
        push_record(&mut p, TYPE_PTR, CLASS_IN, |b| {
            instance_at = b.len();
            push_labels(b, &["Kitchen-abc"]);
            push_pointer(b, service_at);
        });

        push_labels(&mut p, &["Kitchen-abc"]);
        push_pointer(&mut p, service_at);
        push_record(&mut p, TYPE_SRV, CLASS_IN | CLASS_QU, |b| {
            b.extend_from_slice(&[0, 0, 0, 0]);
            b.extend_from_slice(&8009u16.to_be_bytes());
            push_labels(b, &["kitchen"]);
            push_pointer(b, local_at);
        });

        push_pointer(&mut p, instance_at);
        push_record(&mut p, TYPE_TXT, CLASS_IN | CLASS_QU, |b| {
            txt_string(b, "id=abc123");
            txt_string(b, "fn=Kitchen");
            txt_string(b, "md=Chromecast Audio");
            txt_string(b, "ca=4101");
        });

        push_labels(&mut p, &["kitchen"]);
        push_pointer(&mut p, local_at);
        push_record(&mut p, TYPE_A, CLASS_IN | CLASS_QU, |b| {
            b.extend_from_slice(&[192, 168, 1, 50])
        });
        p
    }

    #[test]
    fn query_bytes() {
        let mut expected = vec![0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        expected.push(11);
        expected.extend_from_slice(b"_googlecast");
        expected.push(4);
        expected.extend_from_slice(b"_tcp");
        expected.push(5);
        expected.extend_from_slice(b"local");
        expected.push(0);
        let mut multicast = expected.clone();
        multicast.extend_from_slice(&[0, 12, 0, 1]);
        let mut unicast = expected;
        unicast.extend_from_slice(&[0, 12, 0x80, 1]);

        assert_eq!(build_query(CAST_SERVICE, 0x1234, false), multicast);
        assert_eq!(build_query(CAST_SERVICE, 0x1234, true), unicast);
        assert_eq!(build_query("_googlecast._tcp.local.", 0x1234, true), unicast);
    }

    #[test]
    fn parses_a_compressed_response() {
        let found = parse_response(&cast_response(), CAST_SERVICE);
        assert_eq!(
            found,
            vec![ServiceInstance {
                instance: "Kitchen-abc._googlecast._tcp.local".into(),
                host: Some("kitchen.local".into()),
                port: Some(8009),
                addrs: vec![Ipv4Addr::new(192, 168, 1, 50)],
                txt: vec![
                    ("id".into(), "abc123".into()),
                    ("fn".into(), "Kitchen".into()),
                    ("md".into(), "Chromecast Audio".into()),
                    ("ca".into(), "4101".into()),
                ],
            }]
        );
        assert_eq!(parse_response(&cast_response(), "_GoogleCast._tcp.local."), found);
        assert!(parse_response(&cast_response(), "_airplay._tcp.local").is_empty());
    }

    #[test]
    fn instance_without_ptr_is_found_by_its_srv_owner() {
        let mut p = Vec::new();
        p.extend_from_slice(&[0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
        push_labels(&mut p, &["Den", "_googlecast", "_tcp", "local"]);
        p.push(0);
        push_record(&mut p, TYPE_SRV, CLASS_IN, |b| {
            b.extend_from_slice(&[0, 0, 0, 0, 0x1F, 0x49]);
            push_labels(b, &["den", "local"]);
            b.push(0);
        });
        let found = parse_response(&p, CAST_SERVICE);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].instance, "Den._googlecast._tcp.local");
        assert_eq!(found[0].port, Some(8009));
        assert!(found[0].addrs.is_empty());
    }

    #[test]
    fn txt_keys_are_lowercase_and_bare_keys_get_an_empty_value() {
        let mut rdata = Vec::new();
        txt_string(&mut rdata, "FN=Den");
        txt_string(&mut rdata, "Flag");
        txt_string(&mut rdata, "");
        txt_string(&mut rdata, "a=b=c");
        assert_eq!(
            parse_txt(&rdata),
            vec![
                ("fn".to_string(), "Den".to_string()),
                ("flag".to_string(), String::new()),
                ("a".to_string(), "b=c".to_string()),
            ]
        );
    }

    #[test]
    fn every_truncated_prefix_parses_without_panic() {
        let packet = cast_response();
        for len in 0..=packet.len() {
            let _ = parse_response(&packet[..len], CAST_SERVICE);
        }
        // The PTR record alone is enough for an instance without details.
        let ptr_end = packet.windows(4).position(|w| w == [0, 33, 0x80, 1]).unwrap();
        let partial = parse_response(&packet[..ptr_end - 14], CAST_SERVICE);
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].host, None);
    }

    #[test]
    fn corrupted_bytes_never_panic() {
        let packet = cast_response();
        for i in 0..packet.len() {
            for value in [0x00, 0x3F, 0x40, 0xC0, 0xFF] {
                let mut copy = packet.clone();
                copy[i] = value;
                let _ = parse_response(&copy, CAST_SERVICE);
            }
        }
    }

    #[test]
    fn pointer_loops_terminate() {
        // The name at offset 12 is label "a" followed by a pointer back to offset 12.
        let mut looping = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        looping.extend_from_slice(&[1, b'a', 0xC0, 12]);
        looping.extend_from_slice(&[0, 12, 0, 1, 0, 0, 0, 1, 0, 2, 0xC0, 12]);
        assert!(parse_response(&looping, CAST_SERVICE).is_empty());

        // A pointer to itself and a forward pointer are rejected outright.
        let mut selfref = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        selfref.extend_from_slice(&[0xC0, 12, 0, 12, 0, 1, 0, 0, 0, 1, 0, 0]);
        assert!(parse_response(&selfref, CAST_SERVICE).is_empty());
        assert!(read_name(&[0xC0, 2, 0, 0], 0).is_none());
    }

    #[test]
    fn overlong_names_are_rejected() {
        let mut packet = vec![0u8; 12];
        for _ in 0..10 {
            packet.push(60);
            packet.extend_from_slice(&[b'x'; 60]);
        }
        packet.push(0);
        assert!(read_name(&packet, 12).is_none());
    }
}

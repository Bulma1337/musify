//! Finds renderers: SSDP M-SEARCH for UPnP MediaRenderers and an mDNS query for Cast devices, sent
//! on every LAN interface when a scan is asked for. Only ephemeral UDP sockets through the gate,
//! closed when the scan ends; Musify never listens on the discovery ports (1900, 5353).

use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use musify_audio::source::BlockingClient;

use crate::gate::NetGate;
use crate::mdns::{self, CAST_SERVICE, MDNS_ADDR, ServiceInstance};
use crate::renderer::{DeviceAddress, DeviceKind, FoundDevice, NetworkDevice, Protocol};
use crate::ssdp::{self, MEDIA_RENDERER_ST, SSDP_ADDR};
use crate::upnp::{self, DeviceDescription, ServiceInfo};

/// How long a scan listens for answers.
pub const SCAN_TIME: Duration = Duration::from_secs(3);
/// Description downloads still running after the scan get this much longer.
const DESCRIPTION_GRACE: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(20);
/// Cast devices listen here unless their SRV record says otherwise.
const CAST_PORT: u16 = 8009;
/// Description downloads at the same time.
const MAX_FETCHES: usize = 8;

/// The HTTP client for renderers on the LAN: plain HTTP, no redirects, no proxy, short timeouts.
pub fn lan_client() -> Result<BlockingClient, String> {
    // reqwest needs a TLS configuration even though LAN requests are plain HTTP; one without roots
    // can't reach any https URL, which is intended.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    reqwest::blocking::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .user_agent(concat!("Musify/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.without_url().to_string())
}

/// IPv4 addresses of the interfaces that may reach renderers (no loopback, no link-local).
fn lan_interfaces() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => {
                Some(ip)
            }
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Renderers answer from the LAN; a Cast record pointing elsewhere is ignored.
fn is_lan(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_unique_local() || v6.is_unicast_link_local(),
    }
}

/// A non-blocking UDP socket on `interface` that sends multicast out of that interface.
fn query_socket(gate: &NetGate, interface: Ipv4Addr, ttl: u32) -> io::Result<UdpSocket> {
    let socket = gate.udp_socket(SocketAddr::new(IpAddr::V4(interface), 0))?;
    socket.set_multicast_if_v4(&interface)?;
    socket.set_multicast_ttl_v4(ttl)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ssdp,
    Mdns,
}

/// Runs one scan; `found` gets each device as soon as it is identified (a device may be reported
/// once per protocol). Returns early when the gate closes.
pub fn scan(
    gate: &Arc<NetGate>,
    client: &BlockingClient,
    duration: Duration,
    found: &mut dyn FnMut(FoundDevice),
) -> io::Result<()> {
    gate.check()?;
    let generation = gate.generation();
    let cut_off = || !gate.is_open() || gate.generation() != generation;

    let mut sockets = Vec::new();
    for interface in lan_interfaces() {
        for (kind, ttl) in [(Kind::Ssdp, 2), (Kind::Mdns, 255)] {
            match query_socket(gate, interface, ttl) {
                Ok(socket) => sockets.push((kind, socket)),
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return Err(e),
                Err(e) => log::debug!("network speakers: no discovery socket on an interface: {e}"),
            }
        }
    }
    if sockets.is_empty() {
        return Ok(());
    }

    let msearch = ssdp::msearch_request(MEDIA_RENDERER_ST, 2);
    let query = mdns::build_query(CAST_SERVICE, 0, true);
    let send_all = |sockets: &[(Kind, UdpSocket)]| {
        for (kind, socket) in sockets {
            let sent = match kind {
                Kind::Ssdp => socket.send_to(msearch.as_bytes(), SSDP_ADDR),
                Kind::Mdns => socket.send_to(&query, MDNS_ADDR),
            };
            if let Err(e) = sent {
                log::debug!("network speakers: discovery query not sent: {e}");
            }
        }
    };

    let (tx, rx) = crossbeam_channel::unbounded::<FoundDevice>();
    let mut locations = HashSet::new();
    let mut seen = HashSet::new();
    let mut pending: Vec<(String, IpAddr)> = Vec::new();
    let mut fetches: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut buf = vec![0u8; 9000];
    let start = Instant::now();
    let mut resend_at = Some(start + Duration::from_millis(800));
    send_all(&sockets);

    loop {
        if cut_off() {
            return Ok(());
        }
        let now = Instant::now();
        if resend_at.is_some_and(|t| now >= t) {
            // UDP gets lost; one repeat catches devices that missed the first query.
            resend_at = None;
            send_all(&sockets);
        }
        let listening = now < start + duration;
        if listening {
            for (kind, socket) in &sockets {
                while let Ok((len, from)) = socket.recv_from(&mut buf) {
                    let packet = &buf[..len];
                    match kind {
                        Kind::Ssdp => {
                            let Some(response) = ssdp::parse_response(packet) else {
                                continue;
                            };
                            if ssdp::location_matches_sender(&response.location, from.ip())
                                && locations.insert(response.location.clone())
                            {
                                pending.push((response.location, from.ip()));
                            }
                        }
                        Kind::Mdns => {
                            for instance in mdns::parse_response(packet, CAST_SERVICE) {
                                if let Some(device) = cast_device(&instance, from.ip())
                                    && seen.insert(device.device.id.clone())
                                {
                                    found(device);
                                }
                            }
                        }
                    }
                }
            }
        }
        fetches.retain(|f| !f.is_finished());
        while fetches.len() < MAX_FETCHES
            && let Some((location, ip)) = pending.pop()
        {
            let client = client.clone();
            let tx: Sender<FoundDevice> = tx.clone();
            let spawned = std::thread::Builder::new()
                .name("musify-cast-describe".into())
                .spawn(move || match upnp::fetch_description(&client, &location) {
                    Ok(description) => {
                        if let Some(device) = upnp_device(description, ip) {
                            let _ = tx.send(device);
                        }
                    }
                    Err(e) => log::debug!("network speakers: device description failed: {e}"),
                });
            match spawned {
                Ok(handle) => fetches.push(handle),
                Err(e) => log::debug!("network speakers: no thread for a description: {e}"),
            }
        }
        while let Ok(device) = rx.try_recv() {
            if seen.insert(device.device.id.clone()) {
                found(device);
            }
        }
        let done = !listening && pending.is_empty() && fetches.is_empty();
        if done || now >= start + duration + DESCRIPTION_GRACE {
            break;
        }
        std::thread::sleep(POLL);
    }
    drop(tx);
    while let Ok(device) = rx.try_recv() {
        if seen.insert(device.device.id.clone()) {
            found(device);
        }
    }
    Ok(())
}

/// Keeps a service only if its control URL points at the device itself; otherwise SOAP requests
/// (with the proxy token inside) could be sent to another host.
fn on_device(service: Option<ServiceInfo>, ip: IpAddr) -> Option<ServiceInfo> {
    service.filter(|s| ssdp::location_matches_sender(&s.control_url, ip))
}

fn upnp_device(mut description: DeviceDescription, ip: IpAddr) -> Option<FoundDevice> {
    description.av_transport = on_device(description.av_transport.take(), ip);
    description.av_transport.as_ref()?;
    description.rendering_control = on_device(description.rendering_control.take(), ip);
    description.connection_manager = on_device(description.connection_manager.take(), ip);
    let device = NetworkDevice {
        id: format!("upnp:{}", description.udn),
        name: description.friendly_name.trim().to_string(),
        protocol: Protocol::Upnp,
        kind: upnp_kind(&description),
        model: description
            .model_name
            .clone()
            .filter(|m| !m.trim().is_empty()),
    };
    Some(FoundDevice {
        device,
        address: DeviceAddress::Upnp(Box::new(description)),
        ip,
    })
}

/// UPnP has no device class for TVs; their names and models usually say so.
fn upnp_kind(description: &DeviceDescription) -> DeviceKind {
    let texts = [
        Some(&description.friendly_name),
        description.model_name.as_ref(),
        description.model_description.as_ref(),
    ];
    let is_tv = texts.into_iter().flatten().any(|text| {
        text.to_ascii_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| word == "tv" || word == "television")
    });
    if is_tv {
        DeviceKind::Tv
    } else {
        DeviceKind::Speaker
    }
}

/// Capability bits of the Cast TXT record `ca`.
const CA_VIDEO_OUT: u32 = 1;
const CA_GROUP: u32 = 32;

fn cast_device(instance: &ServiceInstance, from: IpAddr) -> Option<FoundDevice> {
    let txt = |key: &str| {
        instance
            .txt
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };
    let ip = instance
        .addrs
        .first()
        .map(|a| IpAddr::V4(*a))
        .unwrap_or(from);
    if !is_lan(ip) {
        return None;
    }
    let id = txt("id")
        .map(str::to_string)
        .unwrap_or_else(|| instance.instance.clone());
    let name = txt("fn").map(str::to_string).unwrap_or_else(|| {
        instance
            .instance
            .split('.')
            .next()
            .unwrap_or("")
            .to_string()
    });
    let capabilities: u32 = txt("ca").and_then(|v| v.parse().ok()).unwrap_or(0);
    let kind = if capabilities & CA_GROUP != 0 {
        DeviceKind::Group
    } else if capabilities & CA_VIDEO_OUT != 0 {
        DeviceKind::Tv
    } else {
        DeviceKind::Speaker
    };
    Some(FoundDevice {
        device: NetworkDevice {
            id: format!("cast:{id}"),
            name,
            protocol: Protocol::Cast,
            kind,
            model: txt("md").map(str::to_string),
        },
        address: DeviceAddress::Cast(SocketAddr::new(ip, instance.port.unwrap_or(CAST_PORT))),
        ip,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn description(name: &str, control: &str) -> DeviceDescription {
        let service = |kind: &str| ServiceInfo {
            service_type: format!("urn:schemas-upnp-org:service:{kind}:1"),
            control_url: control.to_string(),
        };
        DeviceDescription {
            udn: "uuid:1234".into(),
            device_type: "urn:schemas-upnp-org:device:MediaRenderer:1".into(),
            friendly_name: name.into(),
            manufacturer: None,
            model_name: Some("Streamer 2".into()),
            model_description: None,
            av_transport: Some(service("AVTransport")),
            rendering_control: Some(service("RenderingControl")),
            connection_manager: Some(service("ConnectionManager")),
        }
    }

    #[test]
    fn upnp_devices_need_their_control_urls_on_the_device() {
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        let ok = upnp_device(
            description("Living room", "http://192.168.1.20:1400/ctl"),
            ip,
        )
        .unwrap();
        assert_eq!(ok.device.id, "upnp:uuid:1234");
        assert_eq!(ok.device.kind, DeviceKind::Speaker);
        assert_eq!(ok.device.model.as_deref(), Some("Streamer 2"));
        assert!(upnp_device(description("Elsewhere", "http://192.168.1.99/ctl"), ip).is_none());
        assert!(upnp_device(description("Https", "https://192.168.1.20/ctl"), ip).is_none());
    }

    #[test]
    fn tvs_are_recognized_by_name() {
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        let tv = upnp_device(description("[TV] Living room", "http://10.0.0.2/c"), ip).unwrap();
        assert_eq!(tv.device.kind, DeviceKind::Tv);
        let not_tv = upnp_device(description("Stevie's speaker", "http://10.0.0.2/c"), ip).unwrap();
        assert_eq!(not_tv.device.kind, DeviceKind::Speaker);
    }

    fn instance(txt: &[(&str, &str)], addrs: Vec<Ipv4Addr>) -> ServiceInstance {
        ServiceInstance {
            instance: "Kitchen-abc._googlecast._tcp.local".into(),
            host: Some("abc.local".into()),
            port: Some(8009),
            addrs,
            txt: txt
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn cast_devices_from_txt_records() {
        let from: IpAddr = "192.168.1.30".parse().unwrap();
        let speaker = cast_device(
            &instance(
                &[
                    ("id", "abc"),
                    ("fn", "Kitchen"),
                    ("md", "Speaker Mini"),
                    ("ca", "199172"),
                ],
                vec!["192.168.1.30".parse().unwrap()],
            ),
            from,
        )
        .unwrap();
        assert_eq!(speaker.device.id, "cast:abc");
        assert_eq!(speaker.device.name, "Kitchen");
        assert_eq!(speaker.device.kind, DeviceKind::Speaker);
        assert!(matches!(speaker.address, DeviceAddress::Cast(a) if a.port() == 8009));

        let tv = cast_device(&instance(&[("id", "t"), ("ca", "4101")], vec![]), from).unwrap();
        assert_eq!(tv.device.kind, DeviceKind::Tv);
        assert_eq!(tv.device.name, "Kitchen-abc");
        assert_eq!(tv.ip, from);

        let group = cast_device(&instance(&[("id", "g"), ("ca", "199204")], vec![]), from).unwrap();
        assert_eq!(group.device.kind, DeviceKind::Group);
    }

    #[test]
    fn cast_records_pointing_off_the_lan_are_ignored() {
        let from: IpAddr = "192.168.1.30".parse().unwrap();
        let public = instance(&[("id", "x")], vec!["8.8.8.8".parse().unwrap()]);
        assert!(cast_device(&public, from).is_none());
    }

    #[test]
    fn a_closed_gate_sends_nothing() {
        let gate = Arc::new(NetGate::new());
        let client = lan_client().unwrap();
        let mut found = Vec::new();
        let result = scan(&gate, &client, Duration::from_millis(100), &mut |d| {
            found.push(d)
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert!(found.is_empty());
        assert_eq!(gate.sockets_opened(), 0);
    }
}

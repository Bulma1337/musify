//! Connecting to a found device: the renderer, plus the LAN proxy it will fetch from.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use serde::Serialize;

use crate::cast::CastRenderer;
use crate::discovery::lan_client;
use crate::dlna::DlnaRenderer;
use crate::gate::NetGate;
use crate::proxy::Proxy;
use crate::renderer::{DeviceAddress, FoundDevice, NetworkDevice, Renderer};
use crate::session::ProxyHost;

/// What the player needs to know about the connected device.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub device: NetworkDevice,
    /// Audio MIME types the device plays; empty = unknown.
    pub mimes: Vec<String>,
    pub max_sample_rate: Option<u32>,
    /// Device volume 0.0…1.0, if it reports one.
    pub volume: Option<f64>,
}

pub struct Connected {
    pub renderer: Box<dyn Renderer>,
    pub host: ProxyHost,
    pub info: SessionInfo,
}

/// The local address the system uses to reach `target` (no packet is sent: a UDP "connect" only
/// picks the route).
fn local_ip_for(gate: &NetGate, target: IpAddr) -> io::Result<IpAddr> {
    let bind = match target {
        IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED), 0),
    };
    let socket = gate.udp_socket(bind)?;
    socket.connect(&SocketAddr::new(target, 9).into())?;
    socket
        .local_addr()?
        .as_socket()
        .map(|a| a.ip())
        .ok_or_else(|| io::Error::other("no local address"))
}

/// Connects to `device` and opens the proxy it fetches from. Blocks for a few seconds at most;
/// call it outside any async runtime.
pub fn connect(gate: &Arc<NetGate>, device: &FoundDevice) -> Result<Connected, String> {
    gate.check().map_err(|e| e.to_string())?;
    let local_ip = local_ip_for(gate, device.ip).map_err(|e| e.to_string())?;
    let (mut renderer, dlna): (Box<dyn Renderer>, bool) = match &device.address {
        DeviceAddress::Upnp(description) => {
            let client = lan_client()?;
            let renderer = DlnaRenderer::connect(gate.clone(), client, description)
                .map_err(|e| e.to_string())?;
            (Box::new(renderer), true)
        }
        DeviceAddress::Cast(addr) => {
            let renderer = CastRenderer::connect(gate.clone(), *addr).map_err(|e| e.to_string())?;
            (Box::new(renderer), false)
        }
    };
    let proxy = match Proxy::start(gate.clone(), local_ip, device.ip) {
        Ok(proxy) => proxy,
        Err(e) => {
            renderer.close();
            return Err(e.to_string());
        }
    };
    let volume = renderer.status().ok().and_then(|s| s.volume);
    let info = SessionInfo {
        device: device.device.clone(),
        mimes: renderer.supported_mimes(),
        max_sample_rate: renderer.max_sample_rate(),
        volume,
    };
    Ok(Connected {
        renderer,
        host: ProxyHost::new(proxy, dlna),
        info,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::{DeviceKind, Protocol};

    #[test]
    fn a_closed_gate_connects_nowhere() {
        let gate = Arc::new(NetGate::new());
        let device = FoundDevice {
            device: NetworkDevice {
                id: "cast:x".into(),
                name: "X".into(),
                protocol: Protocol::Cast,
                kind: DeviceKind::Speaker,
                model: None,
            },
            address: DeviceAddress::Cast("127.0.0.1:8009".parse().unwrap()),
            ip: "127.0.0.1".parse().unwrap(),
        };
        assert!(connect(&gate, &device).is_err());
        assert_eq!(gate.sockets_opened(), 0);
    }
}

//! The hard switch for everything network speakers do on the network.
//!
//! Every socket this crate creates (discovery queries, the LAN proxy's listener, connections to a
//! renderer) is opened through a [`NetGate`]. While the gate is closed, no socket is created at all:
//! the calls fail before touching the OS. The gate starts closed and only the app opens it, from the
//! user's local setting; nothing received from the network can open it.

use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};

#[derive(Debug, Default)]
pub struct NetGate {
    open: AtomicBool,
    /// Incremented on every close, so long-running work can notice it was cut off.
    generation: AtomicU64,
    /// Sockets created through this gate (for tests and diagnostics).
    opened: AtomicUsize,
}

impl NetGate {
    /// A closed gate.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_open(&self, open: bool) {
        if !open {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        self.open.store(open, Ordering::SeqCst);
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Changes whenever the gate closes; work started under an older generation must stop.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Number of sockets created through this gate so far.
    pub fn sockets_opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    /// Fails with [`closed_error`] while the gate is closed.
    pub fn check(&self) -> io::Result<()> {
        if self.is_open() {
            Ok(())
        } else {
            Err(closed_error())
        }
    }

    /// An IPv4 UDP socket bound to `bind` (discovery queries).
    pub fn udp_socket(&self, bind: SocketAddr) -> io::Result<Socket> {
        self.check()?;
        let socket = Socket::new(Domain::for_address(bind), Type::DGRAM, Some(Protocol::UDP))?;
        self.opened.fetch_add(1, Ordering::SeqCst);
        socket.bind(&bind.into())?;
        Ok(socket)
    }

    /// A TCP listener (the LAN proxy).
    pub fn tcp_listener(&self, bind: SocketAddr) -> io::Result<TcpListener> {
        self.check()?;
        let listener = TcpListener::bind(bind)?;
        self.opened.fetch_add(1, Ordering::SeqCst);
        Ok(listener)
    }

    /// An outgoing TCP connection to a renderer.
    pub fn tcp_connect(&self, addr: SocketAddr, timeout: Duration) -> io::Result<TcpStream> {
        self.check()?;
        let stream = TcpStream::connect_timeout(&addr, timeout)?;
        self.opened.fetch_add(1, Ordering::SeqCst);
        Ok(stream)
    }
}

/// The error every gated call returns while network speakers are off.
pub fn closed_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "network speakers are turned off",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_gate_creates_no_socket() {
        let gate = NetGate::new();
        let any: SocketAddr = "127.0.0.1:0".parse().unwrap();
        assert!(gate.udp_socket(any).is_err());
        assert!(gate.tcp_listener(any).is_err());
        assert!(gate.tcp_connect(any, Duration::from_millis(50)).is_err());
        assert_eq!(gate.sockets_opened(), 0);
    }

    #[test]
    fn closing_bumps_the_generation() {
        let gate = NetGate::new();
        gate.set_open(true);
        let before = gate.generation();
        gate.set_open(false);
        assert_ne!(gate.generation(), before);
        assert!(!gate.is_open());
    }
}

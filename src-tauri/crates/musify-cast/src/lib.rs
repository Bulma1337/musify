//! Network speakers: find renderers on the local network and play Musify's queue on them.
//!
//! ```text
//! discovery (SSDP + mDNS, one-shot queries) ──► FoundDevice ──connect──► Box<dyn Renderer>
//!                                                                      (dlna: UPnP AV over SOAP,
//!                                                                       cast: Cast v2 over TLS)
//! UI ──RemoteCommand──► session thread ──load/play/seek…──► renderer ──HTTP GET──► proxy ──► server
//!    ◄──EngineEvent────  (same events as the local engine)                        (LAN, secret token,
//!                                                                                   renderer IP only)
//! ```
//!
//! Rules:
//! - Every socket goes through [`gate::NetGate`]. While it is closed nothing is sent and nothing listens.
//! - Musify only controls devices. It never answers discovery, never listens for NOTIFY/multicast
//!   traffic, and the proxy port exists only during a session.
//! - Renderers never see the server's URLs or credentials: they get proxy URLs with a random token.
//!   Neither stream URLs nor proxy URLs are ever logged.

pub mod cast;
pub mod castv2;
pub mod connect;
pub mod discovery;
pub mod dlna;
pub mod gate;
pub mod mdns;
pub mod proxy;
pub mod renderer;
pub mod session;
pub mod ssdp;
pub mod upnp;

pub use gate::NetGate;
pub use renderer::{DeviceKind, FoundDevice, MediaItem, NetworkDevice, Protocol, Renderer};

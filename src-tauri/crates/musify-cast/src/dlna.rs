//! UPnP AV / DLNA MediaRenderer control: AVTransport, RenderingControl and ConnectionManager over SOAP.

use std::sync::Arc;

use musify_audio::source::BlockingClient;

use crate::gate::NetGate;
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus};
use crate::upnp::DeviceDescription;

pub struct DlnaRenderer {
    _private: (),
}

impl DlnaRenderer {
    /// Checks that the device has AVTransport and reads its supported formats once
    /// (`GetProtocolInfo`; a failure leaves the list empty = unknown). Every later request first
    /// checks `gate` and fails with `RendererError::Connection` once it is closed.
    pub fn connect(
        _gate: Arc<NetGate>,
        _client: BlockingClient,
        _description: &DeviceDescription,
    ) -> Result<Self, RendererError> {
        todo!("DlnaRenderer::connect")
    }
}

impl Renderer for DlnaRenderer {
    fn supported_mimes(&self) -> Vec<String> {
        todo!()
    }

    fn load(&mut self, _item: &MediaItem, _start_ms: u64, _play: bool) -> Result<(), RendererError> {
        todo!()
    }

    fn set_next(&mut self, _item: Option<&MediaItem>) -> Result<(), RendererError> {
        todo!()
    }

    fn play(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn pause(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn stop(&mut self) -> Result<(), RendererError> {
        todo!()
    }

    fn seek(&mut self, _position_ms: u64) -> Result<(), RendererError> {
        todo!()
    }

    fn set_volume(&mut self, _volume: f64) -> Result<(), RendererError> {
        todo!()
    }

    fn status(&mut self) -> Result<RendererStatus, RendererError> {
        todo!()
    }

    fn close(&mut self) {}
}

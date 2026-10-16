//! Engine controller: owns the source manager, the current/next track workers, the DSP thread and the
//! output, and turns `EngineCommand`s into playback. Implemented after the other modules.

use crossbeam_channel::Receiver;

use crate::api::{DeviceInfo, EngineCommand, EngineEvent, EqConfig, EqResponse, SpectrumFrame};
use crate::source::CacheConfig;

pub struct EngineInit {
    pub cache: CacheConfig,
}

/// Handle to the running engine. Cheap to share behind an `Arc`.
pub struct AudioEngine {}

impl AudioEngine {
    pub fn new(init: EngineInit) -> Self {
        let _ = init;
        todo!("engine: AudioEngine::new")
    }

    /// Never blocks.
    pub fn send(&self, command: EngineCommand) {
        let _ = command;
        todo!("engine: send")
    }

    pub fn events(&self) -> Receiver<EngineEvent> {
        todo!("engine: events")
    }

    pub fn spectrum(&self) -> Receiver<SpectrumFrame> {
        todo!("engine: spectrum")
    }

    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        crate::output::list_devices()
    }

    pub fn eq_response(&self, config: &EqConfig, points: usize) -> EqResponse {
        let _ = (config, points);
        todo!("engine: eq_response")
    }
}

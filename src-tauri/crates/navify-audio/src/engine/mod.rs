//! Engine controller: owns the source manager, the current/next track workers, the mixer (DSP)
//! thread, the analyzer and the output, and turns `EngineCommand`s into playback.
//!
//! Threads: one control thread (this module), one mixer thread per output pipeline, one analyzer
//! thread, one decoder thread per loaded track, plus the output backend's callback thread.

mod controller;
pub(crate) mod gain;
pub(crate) mod mixer;
mod pipeline;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread::JoinHandle;

use crossbeam_channel::{Receiver, Sender};
use rtrb::Consumer;

use crate::api::{
    DeviceInfo, EngineCommand, EngineEvent, EqConfig, EqResponse, OutputConfig, SpectrumFrame,
};
use crate::output::{OutputError, OutputEvent, OutputRequest, OutputStream};
use crate::source::CacheConfig;

/// Creates output streams. The default talks to real devices; tests use a null backend.
pub trait OutputFactory: Send {
    /// Shared-mode rate the configured device runs at.
    fn sample_rate(&mut self, config: &OutputConfig) -> Result<u32, OutputError>;
    fn open(
        &mut self,
        config: &OutputConfig,
        request: OutputRequest,
        ring: Consumer<f32>,
        events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError>;
}

/// Real audio devices (cpal shared mode, WASAPI exclusive on Windows).
pub struct DeviceOutput;

impl OutputFactory for DeviceOutput {
    fn sample_rate(&mut self, config: &OutputConfig) -> Result<u32, OutputError> {
        crate::output::device_sample_rate(config)
    }

    fn open(
        &mut self,
        config: &OutputConfig,
        request: OutputRequest,
        ring: Consumer<f32>,
        events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError> {
        crate::output::open(config, request, ring, events)
    }
}

pub struct EngineInit {
    pub cache: CacheConfig,
    pub output: Box<dyn OutputFactory>,
}

impl EngineInit {
    /// Engine playing on real devices.
    pub fn with_devices(cache: CacheConfig) -> Self {
        Self {
            cache,
            output: Box::new(DeviceOutput),
        }
    }
}

/// Handle to the running engine. Cheap to share behind an `Arc`; dropping it shuts the engine down.
pub struct AudioEngine {
    commands: Sender<EngineCommand>,
    events: Receiver<EngineEvent>,
    spectrum: Receiver<SpectrumFrame>,
    sample_rate: Arc<AtomicU32>,
    thread: Option<JoinHandle<()>>,
}

impl AudioEngine {
    pub fn new(init: EngineInit) -> Self {
        let (commands, command_rx) = crossbeam_channel::unbounded();
        let (event_tx, events) = crossbeam_channel::unbounded();
        // Bounded: a slow UI must not make analyzer frames pile up.
        let (spectrum_tx, spectrum) = crossbeam_channel::bounded(4);
        let sample_rate = Arc::new(AtomicU32::new(48_000));
        let thread = {
            let sample_rate = sample_rate.clone();
            std::thread::Builder::new()
                .name("navify-engine".into())
                .spawn(move || {
                    controller::run(init, command_rx, event_tx, spectrum_tx, sample_rate)
                })
                .expect("spawn engine control thread")
        };
        Self {
            commands,
            events,
            spectrum,
            sample_rate,
            thread: Some(thread),
        }
    }

    /// Never blocks.
    pub fn send(&self, command: EngineCommand) {
        let _ = self.commands.send(command);
    }

    /// Engine events. Meant for a single consumer (events are not duplicated across clones).
    pub fn events(&self) -> Receiver<EngineEvent> {
        self.events.clone()
    }

    /// Analyzer frames while `SetSpectrum { enabled: true }` is active.
    pub fn spectrum(&self) -> Receiver<SpectrumFrame> {
        self.spectrum.clone()
    }

    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        crate::output::list_devices()
    }

    /// Frequency response of `config` at the current output rate.
    pub fn eq_response(&self, config: &EqConfig, points: usize) -> EqResponse {
        crate::dsp::eq_response(config, self.sample_rate.load(Ordering::Relaxed), points)
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.commands.send(EngineCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

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
    BassEnhancerConfig, DeviceInfo, DeviceSampleFormat, DspConfig, EngineCommand, EngineEvent,
    EqConfig, EqResponse, OutputConfig, SpectrumFrame,
};
use crate::output::{OutputError, OutputEvent, OutputRequest, OutputStream, SourceSpec};
use crate::source::{CacheConfig, SourceEventSink, SourceManager};

/// Creates output streams. The default talks to real devices; tests use a null backend.
pub trait OutputFactory: Send {
    /// Shared-mode rate the configured device runs at.
    fn sample_rate(&mut self, config: &OutputConfig) -> Result<u32, OutputError>;
    fn open(
        &mut self,
        config: &OutputConfig,
        request: OutputRequest,
        ring: Consumer<f64>,
        events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError>;
    /// Rate and sample format an exclusive stream for `source` would get on the configured device
    /// (from its capabilities), so the engine knows whether the next track needs a reopen.
    /// `None` = unknown; the engine then compares native rates.
    fn exclusive_format_for(
        &mut self,
        _config: &OutputConfig,
        _source: &SourceSpec,
    ) -> Option<(u32, DeviceSampleFormat)> {
        None
    }
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
        ring: Consumer<f64>,
        events: Sender<OutputEvent>,
    ) -> Result<Box<dyn OutputStream>, OutputError> {
        crate::output::open(config, request, ring, events)
    }

    fn exclusive_format_for(
        &mut self,
        config: &OutputConfig,
        source: &SourceSpec,
    ) -> Option<(u32, DeviceSampleFormat)> {
        crate::output::exclusive_format_for(config, source)
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
    sources: Arc<SourceManager>,
    thread: Option<JoinHandle<()>>,
}

impl AudioEngine {
    pub fn new(init: EngineInit) -> Self {
        let (commands, command_rx) = crossbeam_channel::unbounded();
        let (event_tx, events) = crossbeam_channel::unbounded();
        // Bounded: a slow UI must not make analyzer frames pile up.
        let (spectrum_tx, spectrum) = crossbeam_channel::bounded(4);
        let sample_rate = Arc::new(AtomicU32::new(48_000));
        let (source_tx, source_rx) = crossbeam_channel::unbounded();
        let sink: SourceEventSink = Arc::new(move |event| {
            let _ = source_tx.send(event);
        });
        let sources = Arc::new(SourceManager::new(init.cache.clone(), sink));
        let thread = {
            let sample_rate = sample_rate.clone();
            let sources = sources.clone();
            std::thread::Builder::new()
                .name("musify-engine".into())
                .spawn(move || {
                    controller::run(
                        init,
                        sources,
                        source_rx,
                        command_rx,
                        event_tx,
                        spectrum_tx,
                        sample_rate,
                    )
                })
                .expect("spawn engine control thread")
        };
        Self {
            commands,
            events,
            spectrum,
            sample_rate,
            sources,
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

    /// Changes the size limit of the streaming cache; least recently used entries are evicted
    /// immediately when the cache is larger than the new limit.
    pub fn set_cache_limit(&self, max_bytes: u64) {
        self.sources.set_cache_limit(max_bytes);
    }

    /// Bytes currently used by the streaming cache.
    pub fn cache_size(&self) -> u64 {
        self.sources.cache_size()
    }

    /// Deletes all cached streams that are not being played right now.
    pub fn clear_cache(&self) -> std::io::Result<()> {
        self.sources.clear_cache()
    }

    /// Frequency response of the EQ (and, if given, the bass enhancer's shelf) at the current output
    /// rate: exactly what the chain applies (see [`crate::dsp::dsp_response`]).
    pub fn eq_response(
        &self,
        eq: &EqConfig,
        bass: Option<&BassEnhancerConfig>,
        points: usize,
    ) -> EqResponse {
        let config = DspConfig {
            eq: eq.clone(),
            bass: bass.copied().unwrap_or_default(),
            ..DspConfig::default()
        };
        crate::dsp::dsp_response(&config, self.sample_rate.load(Ordering::Relaxed), points)
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

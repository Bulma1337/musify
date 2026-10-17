//! Control thread: turns commands into playback, owns the tracks (current/next), their decoding
//! workers and the output pipeline, and translates worker/mixer/output events into `EngineEvent`s.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, select};

use super::gain::track_gain;
use super::mixer::{MixSlot, MixerEvent, MixerMsg};
use super::pipeline::{Pipeline, PipelineSettings};
use super::{EngineInit, OutputFactory};
use crate::api::{
    CrossfadeConfig, DspConfig, EngineCommand, EngineEvent, ErrorKind, NormalizationConfig,
    OutputConfig, PlaybackState, SourceFormat, SourceLocation, SpectrumFrame, TrackId, TrackSource,
    Transition,
};
use crate::decode::{DecodeError, DecodedInfo, TrackWorker, TrackWorkerConfig, WorkerEvent};
use crate::dsp::volume_to_gain;
use crate::output::{OutputEvent, SourceSpec};
use crate::source::{SourceError, SourceEventSink, SourceManager};

/// Decoded audio buffered per track.
const RING_SECONDS: f64 = 2.0;
/// Ask the UI for the next track this long before the current one ends.
const NEED_NEXT_BEFORE_MS: u64 = 20_000;
/// Longest wait for the device to play out its buffers before it is reopened at a track boundary.
const MAX_DRAIN_WAIT: Duration = Duration::from_millis(250);

struct Track {
    source: TrackSource,
    /// Mixer slot currently playing this track (changes on seek).
    slot: u64,
    worker: Option<TrackWorker>,
    info: Option<DecodedInfo>,
    /// Frames played in earlier slots of this track (before seeks).
    played_before: u64,
    /// Position the current slot started at.
    slot_start_ms: u64,
    position_ms: u64,
    gain: f64,
    started: bool,
    need_next_sent: bool,
}

impl Track {
    fn duration_ms(&self) -> Option<u64> {
        self.info
            .as_ref()
            .and_then(|i| i.duration_ms)
            .or(self.source.duration_hint_ms)
    }
}

fn hint_for(location: &SourceLocation) -> Option<String> {
    match location {
        SourceLocation::Http { container_hint, .. } => container_hint.clone(),
        SourceLocation::Local { path } => {
            path.extension().map(|e| e.to_string_lossy().to_lowercase())
        }
    }
}

fn error_kind(error: &DecodeError) -> ErrorKind {
    match error {
        DecodeError::Unsupported(_) => ErrorKind::UnsupportedFormat,
        DecodeError::Decode(_) => ErrorKind::Decode,
        DecodeError::Source(SourceError::Network(_) | SourceError::Http(_)) => ErrorKind::Network,
        DecodeError::Source(_) | DecodeError::Io(_) => ErrorKind::Io,
    }
}

fn unknown_format() -> SourceFormat {
    SourceFormat {
        codec: String::new(),
        sample_rate: 0,
        bits_per_sample: None,
        channels: 2,
        bitrate_kbps: None,
        lossless: false,
        float: false,
    }
}

/// What an exclusive stream has to carry for a decoded track.
fn spec_of(format: &SourceFormat) -> SourceSpec {
    SourceSpec {
        sample_rate: format.sample_rate,
        bits: if format.lossless {
            format.bits_per_sample
        } else {
            None
        },
        float: format.float,
    }
}

/// The next track needs the device at another rate or format (exclusive mode): it is started on a
/// reopened device once the current track has been played out completely.
struct PendingReopen {
    token: u64,
    spec: SourceSpec,
}

struct Controller {
    factory: Box<dyn OutputFactory>,
    sources: Arc<SourceManager>,
    events: Sender<EngineEvent>,
    spectrum: Sender<SpectrumFrame>,
    sample_rate: Arc<AtomicU32>,
    worker_tx: Sender<WorkerEvent>,
    mixer_tx: Sender<MixerEvent>,
    output_tx: Sender<OutputEvent>,

    dsp: DspConfig,
    volume: f64,
    normalization: NormalizationConfig,
    crossfade: CrossfadeConfig,
    output: OutputConfig,
    spectrum_on: bool,

    pipeline: Option<Pipeline>,
    current: Option<Track>,
    next: Option<Track>,
    /// Tracks replaced by a manual switch whose mixer slot has not reported `Ended` yet.
    retired: HashMap<u64, Track>,
    /// Old slots of the current track after a seek → frames still to be credited to it.
    seek_slots: HashMap<u64, TrackId>,
    /// Exclusive stream already requested for the current track (avoids reopen loops on fallback).
    exclusive_attempt: Option<SourceSpec>,
    pending_reopen: Option<PendingReopen>,
    drain_tokens: u64,
    state: PlaybackState,
    paused: bool,
    slot_counter: u64,
}

pub(super) fn run(
    init: EngineInit,
    commands: Receiver<EngineCommand>,
    events: Sender<EngineEvent>,
    spectrum: Sender<SpectrumFrame>,
    sample_rate: Arc<AtomicU32>,
) {
    let (source_tx, source_rx) = crossbeam_channel::unbounded();
    let sink: SourceEventSink = Arc::new(move |event| {
        let _ = source_tx.send(event);
    });
    let sources = Arc::new(SourceManager::new(init.cache, sink));
    let (worker_tx, worker_rx) = crossbeam_channel::unbounded();
    let (mixer_tx, mixer_rx) = crossbeam_channel::unbounded();
    let (output_tx, output_rx) = crossbeam_channel::unbounded();

    let mut c = Controller {
        factory: init.output,
        sources,
        events,
        spectrum,
        sample_rate,
        worker_tx,
        mixer_tx,
        output_tx,
        dsp: DspConfig::default(),
        volume: 1.0,
        normalization: NormalizationConfig::default(),
        crossfade: CrossfadeConfig::default(),
        output: OutputConfig::default(),
        spectrum_on: false,
        pipeline: None,
        current: None,
        next: None,
        retired: HashMap::new(),
        seek_slots: HashMap::new(),
        exclusive_attempt: None,
        pending_reopen: None,
        drain_tokens: 0,
        state: PlaybackState::Idle,
        paused: false,
        slot_counter: 0,
    };

    loop {
        select! {
            recv(commands) -> cmd => match cmd {
                Ok(EngineCommand::Shutdown) | Err(_) => break,
                Ok(cmd) => c.command(cmd),
            },
            recv(worker_rx) -> ev => if let Ok(ev) = ev { c.worker_event(ev) },
            recv(mixer_rx) -> ev => if let Ok(ev) = ev { c.mixer_event(ev) },
            recv(output_rx) -> ev => if let Ok(ev) = ev { c.output_event(ev) },
            // Buffering is detected by the mixer; source events are informational for now.
            recv(source_rx) -> _ev => {},
        }
    }
    c.pipeline = None;
    c.current = None;
    c.next = None;
}

impl Controller {
    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(event);
    }

    fn rate(&self) -> u32 {
        self.pipeline
            .as_ref()
            .map(|p| p.rate)
            .unwrap_or_else(|| self.sample_rate.load(Ordering::Relaxed))
            .max(1)
    }

    fn frames_to_ms(&self, frames: u64) -> u64 {
        frames * 1000 / u64::from(self.rate())
    }

    fn send(&self, msg: MixerMsg) {
        if let Some(p) = &self.pipeline {
            p.send(msg);
        }
    }

    fn set_state(&mut self, state: PlaybackState) {
        if self.state != state {
            self.state = state;
            self.emit(EngineEvent::StateChanged { state });
        }
    }

    // --------------------------------------------------------------------------------------------
    // Pipeline
    // --------------------------------------------------------------------------------------------

    /// Exclusive mode follows the setting alone: with DSP or volume active the device still runs at
    /// the track's native rate, the output is just not bit-perfect then.
    fn wants_exclusive(&self) -> bool {
        self.output.exclusive
    }

    fn current_spec(&self) -> Option<SourceSpec> {
        self.current
            .as_ref()
            .and_then(|t| t.info.as_ref())
            .map(|i| spec_of(&i.format))
            .filter(|s| s.sample_rate > 0)
    }

    /// Whether the open exclusive stream differs from what `spec` would get (rate or format).
    fn needs_reopen_for(&mut self, spec: &SourceSpec) -> bool {
        if !self.wants_exclusive() || spec.sample_rate == 0 {
            return false;
        }
        let Some((rate, format)) = self
            .pipeline
            .as_ref()
            .map(|p| (p.rate, p.format.sample_format))
        else {
            return false;
        };
        match self.factory.exclusive_format_for(&self.output, spec) {
            Some((want_rate, want_format)) => want_rate != rate || Some(want_format) != format,
            // Capabilities unknown: open at the native rate and let the device negotiate.
            None => spec.sample_rate != rate,
        }
    }

    fn build_pipeline(&mut self, exclusive_source: Option<SourceSpec>) -> bool {
        // Release the device before opening it again (exclusive mode needs that).
        self.pipeline = None;
        let output = OutputConfig {
            device_id: self.output.device_id.clone(),
            exclusive: self.wants_exclusive(),
        };
        let settings = PipelineSettings {
            output: &output,
            exclusive_source,
            dsp: &self.dsp,
            volume_gain: volume_to_gain(self.volume),
            crossfade_frames_ms: self.crossfade.duration_ms,
            skip_same_album: self.crossfade.skip_same_album,
        };
        match Pipeline::build(
            self.factory.as_mut(),
            settings,
            self.mixer_tx.clone(),
            self.output_tx.clone(),
            self.spectrum.clone(),
        ) {
            Ok(mut pipeline) => {
                self.sample_rate.store(pipeline.rate, Ordering::Relaxed);
                pipeline
                    .meters
                    .tap_enabled
                    .store(self.spectrum_on, Ordering::Relaxed);
                if self.paused {
                    pipeline.pause();
                }
                self.pipeline = Some(pipeline);
                self.emit_output_format();
                true
            }
            Err(error) => {
                self.emit(EngineEvent::Error {
                    id: None,
                    kind: ErrorKind::Output,
                    message: error.to_string(),
                    recoverable: true,
                });
                false
            }
        }
    }

    fn emit_output_format(&self) {
        let Some(p) = &self.pipeline else { return };
        let mut format = p.format.clone();
        let source = self.current_spec();
        format.source_rate = source.map(|s| s.sample_rate);
        format.resampled = source.is_some_and(|s| s.sample_rate != format.sample_rate);
        let unity_gain = self
            .current
            .as_ref()
            .is_none_or(|t| (t.gain - 1.0).abs() < 1e-12);
        let carried = match (source, format.sample_format) {
            (Some(s), Some(f)) => f.carries(s.bits, s.float),
            (None, Some(f)) => !f.is_float() && f.valid_bits() >= 24,
            _ => false,
        };
        format.bit_perfect = format.exclusive
            && !format.resampled
            && carried
            && self.dsp.is_bypass()
            && self.volume >= 1.0
            && unity_gain;
        self.emit(EngineEvent::OutputChanged { format });
    }

    /// Rebuilds the output (device change, output settings, exclusive rate) and resumes the current
    /// track at its position.
    fn rebuild(&mut self, exclusive_source: Option<SourceSpec>) {
        let resume = self.current.take();
        let next = self.next.take().map(|n| n.source);
        self.pending_reopen = None;
        self.retired.clear();
        self.seek_slots.clear();
        if !self.build_pipeline(exclusive_source) {
            return;
        }
        if let Some(mut track) = resume {
            track.played_before +=
                self.ms_to_frames(track.position_ms.saturating_sub(track.slot_start_ms));
            self.restart_slot(track);
        }
        if let Some(source) = next {
            self.set_next(Some(source));
        }
    }

    fn ms_to_frames(&self, ms: u64) -> u64 {
        ms * u64::from(self.rate()) / 1000
    }

    // --------------------------------------------------------------------------------------------
    // Tracks
    // --------------------------------------------------------------------------------------------

    /// Spawns a decoding worker for `source` at `start_ms` and returns the mixer slot for it.
    fn spawn_slot(
        &mut self,
        source: &TrackSource,
        start_ms: u64,
        gain: f64,
    ) -> Option<(u64, TrackWorker, MixSlot)> {
        let rate = self.pipeline.as_ref()?.rate;
        self.slot_counter += 1;
        let slot = self.slot_counter;
        let sources = self.sources.clone();
        let location = source.location.clone();
        let open = Box::new(move || sources.open(&location, start_ms));
        let config = TrackWorkerConfig {
            dst_rate: rate,
            ring_frames: (f64::from(rate) * RING_SECONDS) as usize,
            start_ms,
        };
        let (worker, ring) = TrackWorker::spawn(
            slot.to_string(),
            open,
            hint_for(&source.location),
            config,
            self.worker_tx.clone(),
        );
        let mix = MixSlot {
            id: slot,
            ring,
            album_key: source.album_key.clone(),
            gain,
        };
        Some((slot, worker, mix))
    }

    fn gain_for(&self, source: &TrackSource, info: Option<&DecodedInfo>) -> f64 {
        track_gain(
            &self.normalization,
            source.gain.as_ref(),
            info.and_then(|i| i.tag_gain.as_ref()),
            source.album_key.is_some(),
        )
    }

    fn new_track(&mut self, source: TrackSource, start_ms: u64) -> Option<(Track, MixSlot)> {
        let gain = self.gain_for(&source, None);
        let (slot, worker, mix) = self.spawn_slot(&source, start_ms, gain)?;
        let track = Track {
            source,
            slot,
            worker: Some(worker),
            info: None,
            played_before: 0,
            slot_start_ms: start_ms,
            position_ms: start_ms,
            gain,
            started: false,
            need_next_sent: false,
        };
        Some((track, mix))
    }

    /// Replays an already started track from its position in a fresh slot (seek, pipeline rebuild).
    fn restart_slot(&mut self, mut track: Track) {
        let start = track.position_ms;
        let Some((slot, worker, mix)) = self.spawn_slot(&track.source.clone(), start, track.gain)
        else {
            return;
        };
        track.slot = slot;
        track.worker = Some(worker);
        track.slot_start_ms = start;
        self.current = Some(track);
        self.send(MixerMsg::Play(mix));
    }

    fn drop_next(&mut self) {
        self.pending_reopen = None;
        if self.next.take().is_some() {
            self.send(MixerMsg::SetNext(None));
        }
    }

    fn play(&mut self, source: TrackSource, start_ms: u64, paused: bool) {
        self.paused = paused;
        self.exclusive_attempt = None;
        if self.pipeline.is_none() && !self.build_pipeline(None) {
            return;
        }
        if let Some(current) = self.current.take() {
            self.retired.insert(current.slot, current);
        }
        self.drop_next();
        let Some((track, mix)) = self.new_track(source, start_ms) else {
            return;
        };
        self.current = Some(track);
        self.send(MixerMsg::Play(mix));
        if let Some(p) = self.pipeline.as_mut() {
            if paused { p.pause() } else { p.play() }
        }
        self.set_state(PlaybackState::Loading);
    }

    fn set_next(&mut self, source: Option<TrackSource>) {
        self.drop_next();
        let Some(source) = source else { return };
        if self.current.is_none() || self.pipeline.is_none() {
            return;
        }
        if matches!(source.location, SourceLocation::Http { .. }) {
            self.sources.prefetch(&source.location);
        }
        let Some((track, mix)) = self.new_track(source, 0) else {
            return;
        };
        self.next = Some(track);
        self.send(MixerMsg::SetNext(Some(mix)));
    }

    fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        if let Some(p) = self.pipeline.as_mut() {
            if paused { p.pause() } else { p.play() }
        }
        if self.current.is_some() {
            self.set_state(if paused {
                PlaybackState::Paused
            } else {
                PlaybackState::Playing
            });
        }
    }

    fn stop(&mut self) {
        self.send(MixerMsg::Stop);
        if let Some(current) = self.current.take() {
            self.retired.insert(current.slot, current);
        }
        self.next = None;
        self.pending_reopen = None;
        self.set_state(PlaybackState::Stopped);
    }

    fn seek(&mut self, position_ms: u64) {
        let Some(mut track) = self.current.take() else {
            return;
        };
        let position_ms = track
            .duration_ms()
            .map_or(position_ms, |d| position_ms.min(d));
        self.seek_slots.insert(track.slot, track.source.id.clone());
        track.position_ms = position_ms;
        track.need_next_sent = false;
        let id = track.source.id.clone();
        let duration_ms = track.duration_ms();
        self.restart_slot(track);
        if self.paused
            && let Some(p) = self.pipeline.as_mut()
        {
            p.flush();
        }
        self.emit(EngineEvent::Position {
            id,
            position_ms,
            duration_ms,
            buffered_ms: None,
        });
    }

    fn skip_to_next(&mut self) {
        if self.pending_reopen.take().is_some() {
            // The next track waits for a device reopen: start it like a manual play, which opens
            // the device for it.
            if let Some(next) = self.next.take() {
                let paused = self.paused;
                self.play(next.source, 0, paused);
            }
            return;
        }
        let Some(next) = self.next.take() else { return };
        if let Some(current) = self.current.take() {
            self.retired.insert(current.slot, current);
        }
        self.current = Some(next);
        self.send(MixerMsg::SkipToNext);
    }

    fn update_gains(&mut self) {
        for track in [self.current.as_mut(), self.next.as_mut()]
            .into_iter()
            .flatten()
        {
            track.gain = track_gain(
                &self.normalization,
                track.source.gain.as_ref(),
                track.info.as_ref().and_then(|i| i.tag_gain.as_ref()),
                track.source.album_key.is_some(),
            );
        }
        for track in [self.current.as_ref(), self.next.as_ref()]
            .into_iter()
            .flatten()
        {
            self.send(MixerMsg::SetGain {
                id: track.slot,
                gain: track.gain,
            });
        }
        self.emit_output_format();
    }

    // --------------------------------------------------------------------------------------------
    // Commands and events
    // --------------------------------------------------------------------------------------------

    fn command(&mut self, command: EngineCommand) {
        match command {
            EngineCommand::Play {
                track,
                start_ms,
                paused,
            } => self.play(track, start_ms, paused),
            EngineCommand::SetNext { track } => self.set_next(track),
            EngineCommand::Pause => self.set_paused(true),
            EngineCommand::Resume => self.set_paused(false),
            EngineCommand::Stop => self.stop(),
            EngineCommand::Seek { position_ms } => self.seek(position_ms),
            EngineCommand::SkipToNext => self.skip_to_next(),
            EngineCommand::SetVolume { volume } => {
                self.volume = volume.clamp(0.0, 1.0);
                self.send(MixerMsg::Volume(volume_to_gain(self.volume)));
                self.emit_output_format();
            }
            EngineCommand::SetDsp { config } => {
                // Exclusive mode stays open with DSP on; only the bit-perfect flag changes.
                self.dsp = config;
                self.send(MixerMsg::Dsp(Box::new(self.dsp.clone())));
                self.emit_output_format();
            }
            EngineCommand::SetNormalization { config } => {
                self.normalization = config;
                self.update_gains();
            }
            EngineCommand::SetCrossfade { config } => {
                self.crossfade = config;
                let frames = u64::from(config.duration_ms) * u64::from(self.rate()) / 1000;
                self.send(MixerMsg::Crossfade {
                    frames,
                    skip_same_album: config.skip_same_album,
                });
            }
            EngineCommand::SetOutput { config } => {
                self.output = config;
                self.exclusive_attempt = None;
                if self.pipeline.is_some() {
                    let spec = self.current_spec();
                    self.exclusive_attempt = spec;
                    self.rebuild(spec);
                }
            }
            EngineCommand::SetSpectrum { enabled } => {
                self.spectrum_on = enabled;
                if let Some(p) = &self.pipeline {
                    p.meters.tap_enabled.store(enabled, Ordering::Relaxed);
                }
            }
            EngineCommand::Shutdown => {}
        }
    }

    fn track_by_slot_mut(&mut self, slot: u64) -> Option<&mut Track> {
        [self.current.as_mut(), self.next.as_mut()]
            .into_iter()
            .flatten()
            .find(|t| t.slot == slot)
    }

    fn worker_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Ready {
                id,
                info,
                start_frame,
            } => {
                let Ok(slot) = id.parse::<u64>() else { return };
                let rate = u64::from(self.rate());
                let total_frames = match (info.n_frames, info.format.sample_rate) {
                    (Some(n), src) if src > 0 => Some(n * rate / u64::from(src)),
                    _ => info.duration_ms.map(|ms| ms * rate / 1000),
                };
                self.send(MixerMsg::Ready {
                    id: slot,
                    start_frame,
                    total_frames,
                });

                let spec = spec_of(&info.format);
                let normalization = self.normalization;
                let is_current = self.current.as_ref().is_some_and(|t| t.slot == slot);
                let is_next = self.next.as_ref().is_some_and(|t| t.slot == slot);
                if let Some(track) = self.track_by_slot_mut(slot) {
                    track.gain = track_gain(
                        &normalization,
                        track.source.gain.as_ref(),
                        info.tag_gain.as_ref(),
                        track.source.album_key.is_some(),
                    );
                    track.info = Some(info);
                    let gain = track.gain;
                    self.send(MixerMsg::SetGain { id: slot, gain });
                }

                if is_current {
                    // Exclusive mode: open the device for the track's native rate and format.
                    if self.exclusive_attempt != Some(spec) && self.needs_reopen_for(&spec) {
                        self.exclusive_attempt = Some(spec);
                        self.rebuild(Some(spec));
                    } else {
                        self.emit_output_format();
                    }
                } else if is_next
                    && self.pipeline.as_ref().is_some_and(|p| p.format.exclusive)
                    && self.needs_reopen_for(&spec)
                {
                    // Rate change at the boundary (exclusive mode): rather than resampling the next
                    // track, play the current one out, then reopen the device at the next track's
                    // rate and start it there. Costs a short gap, keeps every track bit-perfect.
                    // Tracks at the same rate (albums) still run gapless or crossfaded.
                    if let Some(next) = self.next.as_mut() {
                        next.worker = None;
                    }
                    self.send(MixerMsg::SetNext(None));
                    self.drain_tokens += 1;
                    self.pending_reopen = Some(PendingReopen {
                        token: self.drain_tokens,
                        spec,
                    });
                    self.send(MixerMsg::NotifyDrained(self.drain_tokens));
                }
            }
            WorkerEvent::Finished { id, end_frame } => {
                if let Ok(slot) = id.parse::<u64>() {
                    self.send(MixerMsg::Finished {
                        id: slot,
                        end_frame,
                    });
                }
            }
            WorkerEvent::Error { id, error } => {
                let Ok(slot) = id.parse::<u64>() else { return };
                let kind = error_kind(&error);
                if self.current.as_ref().is_some_and(|t| t.slot == slot) {
                    let track_id = self.current.as_ref().map(|t| t.source.id.clone());
                    self.emit(EngineEvent::Error {
                        id: track_id,
                        kind,
                        message: error.to_string(),
                        recoverable: true,
                    });
                    if self.next.is_some() {
                        self.skip_to_next();
                    } else {
                        self.stop();
                    }
                } else if self.next.as_ref().is_some_and(|t| t.slot == slot) {
                    let next_id = self.next.as_ref().map(|t| t.source.id.clone());
                    self.emit(EngineEvent::Error {
                        id: next_id,
                        kind,
                        message: error.to_string(),
                        recoverable: true,
                    });
                    self.drop_next();
                    if let Some(current) = &self.current {
                        self.emit(EngineEvent::NeedNext {
                            id: current.source.id.clone(),
                        });
                    }
                }
            }
        }
    }

    fn mixer_event(&mut self, event: MixerEvent) {
        match event {
            MixerEvent::Started { id, transition } => {
                // A restarted slot of the current track (seek, rebuild): no new TrackStarted.
                if self
                    .current
                    .as_ref()
                    .is_some_and(|t| t.slot == id && t.started)
                {
                    let state = if self.paused {
                        PlaybackState::Paused
                    } else {
                        PlaybackState::Playing
                    };
                    self.set_state(state);
                    return;
                }
                if self.next.as_ref().is_some_and(|t| t.slot == id) {
                    if let Some(current) = self.current.take() {
                        self.retired.insert(current.slot, current);
                    }
                    self.current = self.next.take();
                }
                let Some(track) = self.current.as_mut().filter(|t| t.slot == id) else {
                    return;
                };
                track.started = true;
                let event = EngineEvent::TrackStarted {
                    id: track.source.id.clone(),
                    transition,
                    duration_ms: track.duration_ms(),
                    format: track
                        .info
                        .as_ref()
                        .map(|i| i.format.clone())
                        .unwrap_or_else(unknown_format),
                };
                self.emit(event);
                let state = if self.paused {
                    PlaybackState::Paused
                } else {
                    PlaybackState::Playing
                };
                self.set_state(state);
                self.emit_output_format();
            }
            MixerEvent::Position { id, frame } => {
                let position_ms = self.frames_to_ms(frame);
                let Some(track) = self.current.as_mut().filter(|t| t.slot == id) else {
                    return;
                };
                track.position_ms = position_ms;
                let duration_ms = track.duration_ms();
                let track_id = track.source.id.clone();
                let need_next = self.next.is_none()
                    && !track.need_next_sent
                    && duration_ms
                        .is_some_and(|d| d.saturating_sub(position_ms) < NEED_NEXT_BEFORE_MS);
                if need_next {
                    track.need_next_sent = true;
                }
                self.emit(EngineEvent::Position {
                    id: track_id.clone(),
                    position_ms,
                    duration_ms,
                    buffered_ms: None,
                });
                if need_next {
                    self.emit(EngineEvent::NeedNext { id: track_id });
                }
            }
            MixerEvent::Ended {
                id,
                played_frames,
                completed,
            } => {
                if let Some(track_id) = self.seek_slots.remove(&id) {
                    if let Some(track) = self.current.as_mut().filter(|t| t.source.id == track_id) {
                        track.played_before += played_frames;
                    }
                    return;
                }
                let finished = if let Some(track) = self.retired.remove(&id) {
                    Some(track)
                } else if self.current.as_ref().is_some_and(|t| t.slot == id) {
                    self.current.take()
                } else {
                    None
                };
                if let Some(track) = finished.filter(|t| t.started) {
                    let played_ms = self.frames_to_ms(track.played_before + played_frames);
                    self.emit(EngineEvent::TrackEnded {
                        id: track.source.id,
                        played_ms,
                        completed,
                    });
                }
            }
            MixerEvent::Drained(token) => self.reopen_for_next(token),
            MixerEvent::Buffering(active) => self.emit(EngineEvent::Buffering { active }),
            MixerEvent::Idle => {
                if self.next.is_none() {
                    self.current = None;
                    self.set_state(PlaybackState::Stopped);
                }
            }
        }
    }

    /// The current track has been played out completely: reopen the device for the waiting next
    /// track and start it there (announced as a gapless transition, first sample unfaded).
    fn reopen_for_next(&mut self, token: u64) {
        let Some(pending) = self.pending_reopen.take_if(|p| p.token == token) else {
            return;
        };
        let Some(next) = self.next.take() else { return };
        if let Some(current) = self.current.take() {
            self.retired.insert(current.slot, current);
        }
        // Let the device play what it still buffers before the stream is closed.
        if let Some(p) = &self.pipeline {
            std::thread::sleep(p.device_latency().min(MAX_DRAIN_WAIT));
        }
        self.exclusive_attempt = Some(pending.spec);
        if !self.build_pipeline(Some(pending.spec)) {
            return;
        }
        let Some((track, mix)) = self.new_track(next.source, 0) else {
            return;
        };
        self.current = Some(track);
        self.send(MixerMsg::Start {
            slot: mix,
            transition: Transition::Gapless,
            fade_in: false,
        });
        if let Some(p) = self.pipeline.as_mut() {
            if self.paused { p.pause() } else { p.play() }
        }
    }

    fn output_event(&mut self, event: OutputEvent) {
        match event {
            OutputEvent::DeviceLost => {
                let fallback = self.output.device_id.take().map(|_| "default".to_string());
                self.emit(EngineEvent::DeviceLost { fallback });
                self.rebuild(self.exclusive_attempt);
            }
            OutputEvent::DefaultDeviceChanged | OutputEvent::StreamInvalidated => {
                if self.output.device_id.is_none()
                    || matches!(event, OutputEvent::StreamInvalidated)
                {
                    self.rebuild(self.exclusive_attempt);
                }
            }
            OutputEvent::Error(message) => {
                self.emit(EngineEvent::Error {
                    id: None,
                    kind: ErrorKind::Output,
                    message,
                    recoverable: true,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceError;

    #[test]
    fn error_kinds_map_to_api() {
        assert_eq!(
            error_kind(&DecodeError::Unsupported("x".into())),
            ErrorKind::UnsupportedFormat
        );
        assert_eq!(
            error_kind(&DecodeError::Source(SourceError::Http(500))),
            ErrorKind::Network
        );
        assert_eq!(
            error_kind(&DecodeError::Decode("x".into())),
            ErrorKind::Decode
        );
    }

    #[test]
    fn hints_come_from_container_or_extension() {
        let local = SourceLocation::Local {
            path: "C:/music/a.FLAC".into(),
        };
        assert_eq!(hint_for(&local).as_deref(), Some("flac"));
    }
}

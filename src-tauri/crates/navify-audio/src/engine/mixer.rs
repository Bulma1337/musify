//! The engine's DSP thread: mixes the current/next track rings (gapless, crossfade, click-free manual
//! switches), applies per-track gain and the master `DspChain`, and feeds the output ring.
//!
//! It only talks to the controller through `MixerMsg` / `MixerEvent` channels and never blocks on
//! them. Per block it does no locking; allocations only happen when the controller hands over new
//! slots or configs (dropping old rings), which is acceptable here because the output ring buffers
//! ~50 ms between this thread and the device callback.

use std::f64::consts::FRAC_PI_2;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use rtrb::{Consumer, Producer};

use crate::ENGINE_CHANNELS;
use crate::api::{DspConfig, Transition};
use crate::dsp::DspChain;

/// Frames processed per iteration.
pub(crate) const BLOCK_FRAMES: usize = 256;
/// Length of the fade used for manual transitions (play, seek, skip, stop).
const SWITCH_FADE_MS: f64 = 10.0;
/// Time for per-track gain changes to settle.
const GAIN_SMOOTH_MS: f64 = 50.0;
/// Interval between position reports.
const POSITION_INTERVAL_MS: f64 = 100.0;

/// A decoded track handed to the mixer.
pub(crate) struct MixSlot {
    pub id: u64,
    pub ring: Consumer<f64>,
    pub album_key: Option<String>,
    pub gain: f64,
}

pub(crate) enum MixerMsg {
    /// Make `slot` the current track (manual transition). The previous current fades out.
    Play(MixSlot),
    SetNext(Option<MixSlot>),
    /// Worker opened the track: absolute frame of the first ring sample and the total length.
    Ready { id: u64, start_frame: u64, total_frames: Option<u64> },
    /// Worker pushed everything; `end_frame` is the absolute frame after the last sample.
    Finished { id: u64, end_frame: u64 },
    SetGain { id: u64, gain: f64 },
    /// Jump to the preloaded next track now (manual transition).
    SkipToNext,
    Stop,
    Dsp(Box<DspConfig>),
    Volume(f64),
    Crossfade { frames: u64, skip_same_album: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MixerEvent {
    Started { id: u64, transition: Transition },
    /// Absolute frame (within the track) that is audible right now.
    Position { id: u64, frame: u64 },
    /// `played_frames` = frames of this slot that were actually mixed.
    Ended { id: u64, played_frames: u64, completed: bool },
    Buffering(bool),
    /// The current track ended with nothing queued.
    Idle,
}

/// Shared between mixer and analyzer: linear pre-limiter peak (f32 bits) and the tap switch.
pub(crate) struct Meters {
    pub peak_bits: AtomicU32,
    pub tap_enabled: AtomicBool,
}

impl Meters {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { peak_bits: AtomicU32::new(0), tap_enabled: AtomicBool::new(false) })
    }

    fn record_peak(&self, linear: f32) {
        // Non-negative floats order like their bit patterns.
        self.peak_bits.fetch_max(linear.max(0.0).to_bits(), Ordering::Relaxed);
    }

    /// Takes the peak since the last call, in dBFS.
    pub fn take_peak_db(&self) -> f32 {
        let linear = f32::from_bits(self.peak_bits.swap(0, Ordering::Relaxed));
        if linear > 0.0 { 20.0 * linear.log10() } else { -120.0 }
    }
}

struct Slot {
    id: u64,
    ring: Consumer<f64>,
    album_key: Option<String>,
    gain: f64,
    gain_target: f64,
    /// Envelope for manual fades (0…1) and its per-frame change.
    env: f64,
    env_step: f64,
    start_frame: Option<u64>,
    total_frames: Option<u64>,
    end_frame: Option<u64>,
    consumed: u64,
    started: bool,
    transition: Transition,
}

impl Slot {
    fn new(s: MixSlot, transition: Transition, fade_in_step: f64) -> Self {
        let instant = transition != Transition::Manual;
        Self {
            id: s.id,
            ring: s.ring,
            album_key: s.album_key,
            gain: s.gain,
            gain_target: s.gain,
            env: if instant { 1.0 } else { 0.0 },
            env_step: if instant { 0.0 } else { fade_in_step },
            start_frame: None,
            total_frames: None,
            end_frame: None,
            consumed: 0,
            started: false,
            transition,
        }
    }

    fn available_frames(&self) -> usize {
        self.ring.slots() / ENGINE_CHANNELS
    }

    /// Finished and fully drained.
    fn is_exhausted(&self) -> bool {
        match (self.end_frame, self.start_frame) {
            (Some(end), Some(start)) => start + self.consumed >= end && self.available_frames() == 0,
            _ => false,
        }
    }

    fn remaining_frames(&self) -> Option<u64> {
        let start = self.start_frame?;
        let total = self.end_frame.or(self.total_frames)?;
        Some(total.saturating_sub(start + self.consumed))
    }

    fn position(&self) -> u64 {
        self.start_frame.unwrap_or(0) + self.consumed
    }

    /// Reads up to `frames` frames and adds them to `out` (interleaved stereo) scaled by `extra`.
    /// Returns frames read. Applies gain smoothing and the manual-fade envelope.
    fn mix_into(&mut self, out: &mut [f64], frames: usize, extra: impl Fn(usize) -> f64, gain_step: f64) -> usize {
        let n = frames.min(self.available_frames());
        if n == 0 {
            return 0;
        }
        let Ok(chunk) = self.ring.read_chunk(n * ENGINE_CHANNELS) else { return 0 };
        let (a, b) = chunk.as_slices();
        let mut samples = a.iter().chain(b.iter());
        for i in 0..n {
            if self.gain != self.gain_target {
                let delta = self.gain_target - self.gain;
                self.gain = if delta.abs() <= gain_step { self.gain_target } else { self.gain + gain_step * delta.signum() };
            }
            if self.env_step != 0.0 {
                self.env = (self.env + self.env_step).clamp(0.0, 1.0);
                if self.env == 0.0 || self.env == 1.0 {
                    self.env_step = 0.0;
                }
            }
            let g = self.gain * self.env * extra(i);
            let l = *samples.next().unwrap_or(&0.0);
            let r = *samples.next().unwrap_or(&0.0);
            out[i * 2] += l * g;
            out[i * 2 + 1] += r * g;
        }
        chunk.commit_all();
        self.consumed += n as u64;
        n
    }
}

struct Crossfade {
    len: u64,
    done: u64,
}

pub(crate) struct Mixer {
    sample_rate: u32,
    chain: DspChain,
    out: Producer<f32>,
    out_capacity_frames: usize,
    target_fill_frames: usize,
    tap: Producer<f32>,
    meters: Arc<Meters>,
    msgs: Receiver<MixerMsg>,
    events: Sender<MixerEvent>,

    current: Option<Slot>,
    next: Option<Slot>,
    outgoing: Option<Slot>,
    crossfade: Option<Crossfade>,
    crossfade_frames: u64,
    skip_same_album: bool,
    buffering: bool,
    idle_reported: bool,

    block: Vec<f64>,
    switch_step: f64,
    gain_step: f64,
    frames_since_position: u64,
    position_interval: u64,
}

impl Mixer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sample_rate: u32,
        chain: DspChain,
        out: Producer<f32>,
        tap: Producer<f32>,
        meters: Arc<Meters>,
        msgs: Receiver<MixerMsg>,
        events: Sender<MixerEvent>,
        target_fill_ms: f64,
    ) -> Self {
        let rate = f64::from(sample_rate);
        let out_capacity_frames = out.buffer().capacity() / ENGINE_CHANNELS;
        let target_fill_frames = ((rate * target_fill_ms / 1000.0) as usize).clamp(BLOCK_FRAMES, out_capacity_frames);
        Self {
            sample_rate,
            chain,
            out,
            out_capacity_frames,
            target_fill_frames,
            tap,
            meters,
            msgs,
            events,
            current: None,
            next: None,
            outgoing: None,
            crossfade: None,
            crossfade_frames: 0,
            skip_same_album: true,
            buffering: false,
            idle_reported: true,
            block: vec![0.0; BLOCK_FRAMES * ENGINE_CHANNELS],
            switch_step: 1.0 / (rate * SWITCH_FADE_MS / 1000.0),
            gain_step: 1.0 / (rate * GAIN_SMOOTH_MS / 1000.0),
            frames_since_position: 0,
            position_interval: (rate * POSITION_INTERVAL_MS / 1000.0) as u64,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Runs until `stop` is set or the message channel disconnects.
    pub fn run(mut self, stop: Arc<AtomicBool>) {
        #[cfg(windows)]
        crate::output::mmcss::register_current_thread();
        while !stop.load(Ordering::Relaxed) {
            if !self.drain_messages() {
                break;
            }
            let free_frames = self.out.slots() / ENGINE_CHANNELS;
            let filled = self.out_capacity_frames - free_frames;
            if filled < self.target_fill_frames && free_frames >= BLOCK_FRAMES {
                self.process_block();
            } else {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    fn emit(&self, event: MixerEvent) {
        let _ = self.events.send(event);
    }

    /// Returns false when the controller is gone.
    fn drain_messages(&mut self) -> bool {
        loop {
            match self.msgs.try_recv() {
                Ok(msg) => self.handle(msg),
                Err(crossbeam_channel::TryRecvError::Empty) => return true,
                Err(crossbeam_channel::TryRecvError::Disconnected) => return false,
            }
        }
    }

    fn slot_mut(&mut self, id: u64) -> Option<&mut Slot> {
        [self.current.as_mut(), self.next.as_mut(), self.outgoing.as_mut()].into_iter().flatten().find(|s| s.id == id)
    }

    fn fade_out_current(&mut self) {
        self.crossfade = None;
        if let Some(mut cur) = self.current.take() {
            self.emit(MixerEvent::Ended { id: cur.id, played_frames: cur.consumed, completed: false });
            cur.env_step = -self.switch_step;
            self.outgoing = Some(cur);
        }
    }

    fn handle(&mut self, msg: MixerMsg) {
        match msg {
            MixerMsg::Play(slot) => {
                self.fade_out_current();
                self.current = Some(Slot::new(slot, Transition::Manual, self.switch_step));
                self.idle_reported = false;
            }
            MixerMsg::SetNext(slot) => {
                self.crossfade = None;
                self.next = slot.map(|s| Slot::new(s, Transition::Gapless, self.switch_step));
            }
            MixerMsg::Ready { id, start_frame, total_frames } => {
                if let Some(s) = self.slot_mut(id) {
                    s.start_frame = Some(start_frame);
                    s.total_frames = total_frames;
                }
            }
            MixerMsg::Finished { id, end_frame } => {
                if let Some(s) = self.slot_mut(id) {
                    s.end_frame = Some(end_frame);
                }
            }
            MixerMsg::SetGain { id, gain } => {
                if let Some(s) = self.slot_mut(id) {
                    s.gain_target = gain;
                }
            }
            MixerMsg::SkipToNext => {
                if let Some(mut next) = self.next.take() {
                    self.fade_out_current();
                    next.transition = Transition::Manual;
                    next.env = 0.0;
                    next.env_step = self.switch_step;
                    self.current = Some(next);
                    self.idle_reported = false;
                }
            }
            MixerMsg::Stop => {
                self.fade_out_current();
                self.next = None;
                self.idle_reported = true;
            }
            MixerMsg::Dsp(config) => self.chain.set_config(&config),
            MixerMsg::Volume(gain) => self.chain.set_volume(gain),
            MixerMsg::Crossfade { frames, skip_same_album } => {
                self.crossfade_frames = frames;
                self.skip_same_album = skip_same_album;
            }
        }
    }

    fn crossfade_allowed(&self) -> bool {
        let (Some(cur), Some(next)) = (&self.current, &self.next) else { return false };
        if self.crossfade_frames == 0 || next.start_frame.is_none() {
            return false;
        }
        !(self.skip_same_album && cur.album_key.is_some() && cur.album_key == next.album_key)
    }

    fn process_block(&mut self) {
        let frames = BLOCK_FRAMES;
        self.block.fill(0.0);
        let mut block = std::mem::take(&mut self.block);

        // Track fading out after a manual switch.
        if let Some(out) = self.outgoing.as_mut() {
            let gain_step = self.gain_step;
            out.mix_into(&mut block, frames, |_| 1.0, gain_step);
            if out.env <= 0.0 || out.available_frames() == 0 {
                self.outgoing = None;
            }
        }

        let mut pos = 0;
        while pos < frames {
            let Some(cur) = self.current.as_ref() else { break };
            let cur_id = cur.id;

            // Start a crossfade when the current track is within the crossfade length of its end.
            if self.crossfade.is_none()
                && self.crossfade_allowed()
                && let Some(remaining) = cur.remaining_frames()
                && remaining <= self.crossfade_frames
            {
                self.crossfade = Some(Crossfade { len: remaining.max(1), done: 0 });
                let next = self.next.as_mut().expect("crossfade_allowed checked next");
                next.transition = Transition::Crossfade;
                next.started = true;
                let next_id = next.id;
                self.emit(MixerEvent::Started { id: next_id, transition: Transition::Crossfade });
            }

            let want = frames - pos;
            if let Some(fade) = self.crossfade.as_ref() {
                let n = (want as u64).min(fade.len - fade.done) as usize;
                let (len, done) = (fade.len as f64, fade.done as f64);
                let gain_step = self.gain_step;
                let slice = &mut block[pos * 2..(pos + n) * 2];
                let cur = self.current.as_mut().expect("current present");
                let got_cur = cur.mix_into(slice, n, |i| ((done + i as f64) / len * FRAC_PI_2).cos(), gain_step);
                let next = self.next.as_mut().expect("next present during crossfade");
                next.mix_into(slice, n, |i| ((done + i as f64) / len * FRAC_PI_2).sin(), gain_step);
                let fade = self.crossfade.as_mut().expect("fade present");
                fade.done += n as u64;
                pos += n;
                let finished = fade.done >= fade.len || (got_cur < n && self.current.as_ref().is_some_and(Slot::is_exhausted));
                if finished {
                    self.finish_current(true);
                    self.promote_next(None);
                    self.crossfade = None;
                }
                continue;
            }

            let gain_step = self.gain_step;
            let cur = self.current.as_mut().expect("current present");
            let got = cur.mix_into(&mut block[pos * 2..], want, |_| 1.0, gain_step);
            if got > 0 && !cur.started {
                cur.started = true;
                let transition = cur.transition;
                self.emit(MixerEvent::Started { id: cur_id, transition });
            }
            pos += got;
            if got > 0 && self.buffering {
                self.buffering = false;
                self.emit(MixerEvent::Buffering(false));
            }
            if got < want {
                let exhausted = self.current.as_ref().is_some_and(Slot::is_exhausted);
                if exhausted {
                    self.finish_current(true);
                    if self.next.is_some() {
                        self.promote_next(Some(Transition::Gapless));
                        continue;
                    }
                    if !self.idle_reported {
                        self.idle_reported = true;
                        self.emit(MixerEvent::Idle);
                    }
                } else if self.current.as_ref().is_some_and(|c| c.started || c.start_frame.is_some()) && !self.buffering {
                    self.buffering = true;
                    self.emit(MixerEvent::Buffering(true));
                }
                break;
            }
        }

        self.chain.process(&mut block);
        self.meters.record_peak(10f32.powf(self.chain.take_peak_db() / 20.0));
        self.write_output(&block);
        self.block = block;
        self.report_position(frames as u64);
    }

    fn finish_current(&mut self, completed: bool) {
        if let Some(cur) = self.current.take() {
            self.emit(MixerEvent::Ended { id: cur.id, played_frames: cur.consumed, completed });
        }
    }

    fn promote_next(&mut self, transition: Option<Transition>) {
        if let Some(mut next) = self.next.take() {
            if let Some(t) = transition {
                next.transition = t;
                next.env = 1.0;
                next.env_step = 0.0;
            }
            if next.started {
                // Already announced (crossfade start).
            } else if next.consumed > 0 || next.available_frames() > 0 {
                next.started = true;
                self.emit(MixerEvent::Started { id: next.id, transition: next.transition });
            }
            self.current = Some(next);
            self.idle_reported = false;
        }
    }

    fn write_output(&mut self, block: &[f64]) {
        let tap_enabled = self.meters.tap_enabled.load(Ordering::Relaxed);
        if let Ok(mut chunk) = self.out.write_chunk_uninit(block.len()) {
            let (a, b) = chunk.as_mut_slices();
            for (dst, src) in a.iter_mut().chain(b.iter_mut()).zip(block.iter()) {
                dst.write(*src as f32);
            }
            // SAFETY: every slot of the chunk was written above (block.len() == chunk length).
            unsafe { chunk.commit_all() };
        }
        if tap_enabled {
            let frames = block.len() / ENGINE_CHANNELS;
            if let Ok(mut chunk) = self.tap.write_chunk_uninit(frames.min(self.tap.slots())) {
                let (a, b) = chunk.as_mut_slices();
                for (dst, pair) in a.iter_mut().chain(b.iter_mut()).zip(block.chunks_exact(2)) {
                    dst.write(((pair[0] + pair[1]) * 0.5) as f32);
                }
                // SAFETY: the zip covers min(chunk, frames) = chunk length slots.
                unsafe { chunk.commit_all() };
            }
        }
    }

    fn report_position(&mut self, frames: u64) {
        self.frames_since_position += frames;
        if self.frames_since_position < self.position_interval {
            return;
        }
        self.frames_since_position = 0;
        let Some(cur) = self.current.as_ref() else { return };
        if !cur.started {
            return;
        }
        // What is audible now lags behind what was mixed by the output ring fill and the DSP latency.
        let filled = (self.out_capacity_frames - self.out.slots() / ENGINE_CHANNELS) as u64;
        let latency = filled + self.chain.latency_frames() as u64;
        let frame = cur.position().saturating_sub(latency);
        self.emit(MixerEvent::Position { id: cur.id, frame });
    }
}

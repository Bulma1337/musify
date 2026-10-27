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
use crate::output::ramp::Control;

/// Frames processed per iteration.
pub(crate) const BLOCK_FRAMES: usize = 256;
/// Length of the fade used for manual transitions (play, seek, skip, stop).
const SWITCH_FADE_MS: f64 = 10.0;
/// Time for per-track gain changes to settle.
const GAIN_SMOOTH_MS: f64 = 50.0;
/// Interval between position reports.
const POSITION_INTERVAL_MS: f64 = 100.0;
/// DSP ring-out (EQ, bass filters) still played after a track ended before the pipeline counts
/// as drained.
const DRAIN_TAIL_MS: f64 = 10.0;
/// Tracks that can fade out at the same time after quick manual switches.
const MAX_OUTGOING: usize = 4;

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
    /// Make `slot` the current track of a freshly opened (silent) pipeline, announced with
    /// `transition`; `fade_in` only when it starts inside the track (no fade at a track start, so
    /// its first samples stay bit-exact).
    Start {
        slot: MixSlot,
        transition: Transition,
        fade_in: bool,
    },
    /// Report `MixerEvent::Drained(token)` once nothing is playing any more and the output ring
    /// has been read empty.
    NotifyDrained(u64),
    SetNext(Option<MixSlot>),
    /// Worker opened the track: absolute frame of the first ring sample and the total length.
    Ready {
        id: u64,
        start_frame: u64,
        total_frames: Option<u64>,
    },
    /// Worker pushed everything; `end_frame` is the absolute frame after the last sample.
    Finished {
        id: u64,
        end_frame: u64,
    },
    SetGain {
        id: u64,
        gain: f64,
    },
    /// Jump to the preloaded next track now (manual transition).
    SkipToNext,
    Stop,
    Dsp(Box<DspConfig>),
    Volume(f64),
    Crossfade {
        frames: u64,
        skip_same_album: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MixerEvent {
    Started {
        id: u64,
        transition: Transition,
    },
    /// Absolute frame (within the track) that is audible right now.
    Position {
        id: u64,
        frame: u64,
    },
    /// `played_frames` = frames of this slot that were actually mixed.
    Ended {
        id: u64,
        played_frames: u64,
        completed: bool,
    },
    Buffering(bool),
    /// The current track ended with nothing queued.
    Idle,
    /// Answer to `MixerMsg::NotifyDrained`.
    Drained(u64),
}

/// Shared between mixer and analyzer: linear pre-limiter peak (f32 bits) and the tap switch.
pub(crate) struct Meters {
    pub peak_bits: AtomicU32,
    pub tap_enabled: AtomicBool,
}

impl Meters {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            peak_bits: AtomicU32::new(0),
            tap_enabled: AtomicBool::new(false),
        })
    }

    fn record_peak(&self, linear: f32) {
        // Non-negative floats order like their bit patterns.
        self.peak_bits
            .fetch_max(linear.max(0.0).to_bits(), Ordering::Relaxed);
    }

    /// Takes the peak since the last call, in dBFS.
    pub fn take_peak_db(&self) -> f32 {
        let linear = f32::from_bits(self.peak_bits.swap(0, Ordering::Relaxed));
        if linear > 0.0 {
            20.0 * linear.log10()
        } else {
            -120.0
        }
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
            (Some(end), Some(start)) => {
                start + self.consumed >= end && self.available_frames() == 0
            }
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
    fn mix_into(
        &mut self,
        out: &mut [f64],
        frames: usize,
        extra: impl Fn(usize) -> f64,
        gain_step: f64,
    ) -> usize {
        let n = frames.min(self.available_frames());
        if n == 0 {
            return 0;
        }
        let Ok(chunk) = self.ring.read_chunk(n * ENGINE_CHANNELS) else {
            return 0;
        };
        let (a, b) = chunk.as_slices();
        let mut samples = a.iter().chain(b.iter());
        for i in 0..n {
            if self.gain != self.gain_target {
                let delta = self.gain_target - self.gain;
                self.gain = if delta.abs() <= gain_step {
                    self.gain_target
                } else {
                    self.gain + gain_step * delta.signum()
                };
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
    chain: DspChain,
    out: Producer<f64>,
    /// Samples pushed to `out` since the pipeline started (positions for cuts).
    written: u64,
    /// The output callback's control block: manual switches cut the audio queued in `out`.
    output: Option<Arc<Control>>,
    out_capacity_frames: usize,
    target_fill_frames: usize,
    tap: Producer<f32>,
    meters: Arc<Meters>,
    msgs: Receiver<MixerMsg>,
    events: Sender<MixerEvent>,

    current: Option<Slot>,
    next: Option<Slot>,
    /// Tracks fading out after a manual switch (preallocated, see `push_outgoing`).
    outgoing: Vec<Slot>,
    /// During a crossfade: the previous track, fading out. The incoming one is already `current`,
    /// so `next` is free for the track after it while the fade runs.
    fading: Option<Slot>,
    crossfade: Option<Crossfade>,
    crossfade_frames: u64,
    skip_same_album: bool,
    buffering: bool,
    idle_reported: bool,
    drain_token: Option<u64>,
    /// Frames mixed since the last block that had a track (current or fading out) in it.
    idle_frames: u64,
    /// Filter ring-out allowed after the last audible sample before reporting `Drained`.
    tail_frames: usize,

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
        out: Producer<f64>,
        tap: Producer<f32>,
        meters: Arc<Meters>,
        msgs: Receiver<MixerMsg>,
        events: Sender<MixerEvent>,
        target_fill_ms: f64,
        output: Option<Arc<Control>>,
    ) -> Self {
        let rate = f64::from(sample_rate);
        let out_capacity_frames = out.buffer().capacity() / ENGINE_CHANNELS;
        let target_fill_frames =
            ((rate * target_fill_ms / 1000.0) as usize).clamp(BLOCK_FRAMES, out_capacity_frames);
        Self {
            chain,
            out,
            written: 0,
            output,
            out_capacity_frames,
            target_fill_frames,
            tap,
            meters,
            msgs,
            events,
            current: None,
            next: None,
            outgoing: Vec::with_capacity(MAX_OUTGOING),
            fading: None,
            crossfade: None,
            crossfade_frames: 0,
            skip_same_album: true,
            buffering: false,
            idle_reported: true,
            drain_token: None,
            idle_frames: 0,
            tail_frames: (rate * DRAIN_TAIL_MS / 1000.0) as usize,
            block: vec![0.0; BLOCK_FRAMES * ENGINE_CHANNELS],
            switch_step: 1.0 / (rate * SWITCH_FADE_MS / 1000.0),
            gain_step: 1.0 / (rate * GAIN_SMOOTH_MS / 1000.0),
            frames_since_position: 0,
            position_interval: (rate * POSITION_INTERVAL_MS / 1000.0) as u64,
        }
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
            // Drained: everything still queued for the device was mixed from nothing (after the
            // DSP latency and a short filter tail), i.e. the last audible sample has been read.
            if let Some(token) = self.drain_token
                && self.current.is_none()
                && self.outgoing.is_empty()
                && self.fading.is_none()
                && self.idle_frames
                    >= (filled + self.chain.latency_frames() + self.tail_frames) as u64
            {
                self.drain_token = None;
                self.emit(MixerEvent::Drained(token));
            }
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
        self.current
            .iter_mut()
            .chain(self.next.iter_mut())
            .chain(self.fading.iter_mut())
            .chain(self.outgoing.iter_mut())
            .find(|s| s.id == id)
    }

    /// Keeps at most `MAX_OUTGOING` fading tracks (the oldest is nearly silent), so pushing never
    /// allocates.
    fn push_outgoing(&mut self, slot: Slot) {
        if self.outgoing.len() == MAX_OUTGOING {
            self.outgoing.remove(0);
        }
        self.outgoing.push(slot);
    }

    /// Fades out whatever plays now (manual switch, stop). A crossfade in progress ends here too:
    /// both of its tracks fade out quickly from the level they had reached, so nothing jumps.
    fn fade_out_current(&mut self) {
        let angle = self
            .crossfade
            .take()
            .map(|f| (f.done as f64 / f.len as f64).min(1.0) * FRAC_PI_2);
        if let Some(mut old) = self.fading.take() {
            self.emit(MixerEvent::Ended {
                id: old.id,
                played_frames: old.consumed,
                completed: true,
            });
            if let Some(a) = angle {
                old.gain *= a.cos();
                old.gain_target *= a.cos();
            }
            old.env_step = -self.switch_step;
            self.push_outgoing(old);
        }
        if let Some(mut cur) = self.current.take() {
            self.emit(MixerEvent::Ended {
                id: cur.id,
                played_frames: cur.consumed,
                completed: false,
            });
            if let Some(a) = angle {
                cur.gain *= a.sin();
                cur.gain_target *= a.sin();
            }
            cur.env_step = -self.switch_step;
            self.push_outgoing(cur);
        }
    }

    /// Manual switch or stop. What plays now must stop right away, not after the ~50 ms queued in
    /// the output ring: the output fades the queued audio out within a few ms and drops the rest
    /// (`Control::request_cut`), so the old tracks end here without a fade of their own, and the DSP
    /// state (filters, limiter look-ahead) starts from silence. Without a cutting output they fade
    /// out as before.
    fn cut_current(&mut self) {
        let Some(output) = self.output.as_ref() else {
            self.fade_out_current();
            return;
        };
        output.request_cut(self.written);
        self.crossfade = None;
        if let Some(old) = self.fading.take() {
            self.emit(MixerEvent::Ended {
                id: old.id,
                played_frames: old.consumed,
                completed: true,
            });
        }
        if let Some(cur) = self.current.take() {
            self.emit(MixerEvent::Ended {
                id: cur.id,
                played_frames: cur.consumed,
                completed: false,
            });
        }
        // Their own fades were queued before the cut as well.
        self.outgoing.clear();
        self.chain.reset();
    }

    fn handle(&mut self, msg: MixerMsg) {
        match msg {
            MixerMsg::Play(slot) => {
                self.cut_current();
                self.current = Some(Slot::new(slot, Transition::Manual, self.switch_step));
                self.idle_reported = false;
            }
            MixerMsg::Start {
                slot,
                transition,
                fade_in,
            } => {
                self.fade_out_current();
                let mut slot = Slot::new(slot, transition, self.switch_step);
                if fade_in {
                    slot.env = 0.0;
                    slot.env_step = self.switch_step;
                } else {
                    slot.env = 1.0;
                    slot.env_step = 0.0;
                }
                self.current = Some(slot);
                self.idle_reported = false;
            }
            MixerMsg::NotifyDrained(token) => self.drain_token = Some(token),
            MixerMsg::SetNext(slot) => {
                // A crossfade in progress is unaffected: its incoming track is already `current`.
                self.next = slot.map(|s| Slot::new(s, Transition::Gapless, self.switch_step));
            }
            MixerMsg::Ready {
                id,
                start_frame,
                total_frames,
            } => {
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
                    self.cut_current();
                    next.transition = Transition::Manual;
                    next.env = 0.0;
                    next.env_step = self.switch_step;
                    self.current = Some(next);
                    self.idle_reported = false;
                }
            }
            MixerMsg::Stop => {
                self.cut_current();
                self.next = None;
                self.idle_reported = true;
            }
            MixerMsg::Dsp(config) => self.chain.set_config(&config),
            MixerMsg::Volume(gain) => self.chain.set_volume(gain),
            MixerMsg::Crossfade {
                frames,
                skip_same_album,
            } => {
                self.crossfade_frames = frames;
                self.skip_same_album = skip_same_album;
            }
        }
    }

    fn crossfade_allowed(&self) -> bool {
        let (Some(cur), Some(next)) = (&self.current, &self.next) else {
            return false;
        };
        if self.crossfade_frames == 0 || next.start_frame.is_none() {
            return false;
        }
        !(self.skip_same_album && cur.album_key.is_some() && cur.album_key == next.album_key)
    }

    fn process_block(&mut self) {
        let frames = BLOCK_FRAMES;
        if self.current.is_some() || !self.outgoing.is_empty() || self.fading.is_some() {
            self.idle_frames = 0;
        } else {
            self.idle_frames += frames as u64;
        }
        self.block.fill(0.0);
        let mut block = std::mem::take(&mut self.block);

        // Tracks fading out after a manual switch.
        let gain_step = self.gain_step;
        for out in self.outgoing.iter_mut() {
            out.mix_into(&mut block, frames, |_| 1.0, gain_step);
        }
        self.outgoing
            .retain(|o| o.env > 0.0 && o.available_frames() > 0);

        let mut pos = 0;
        while pos < frames {
            let Some(cur) = self.current.as_ref() else {
                break;
            };
            let cur_id = cur.id;

            // Start a crossfade when the current track is within the crossfade length of its end:
            // the next track becomes current right away (equal-power fade-in), the old one moves to
            // `fading` and fades out over the same frames.
            if self.crossfade.is_none()
                && self.fading.is_none()
                && self.crossfade_allowed()
                && let Some(remaining) = cur.remaining_frames()
                && remaining <= self.crossfade_frames
            {
                let mut incoming = self.next.take().expect("crossfade_allowed checked next");
                incoming.transition = Transition::Crossfade;
                incoming.started = true;
                incoming.env = 1.0;
                incoming.env_step = 0.0;
                self.emit(MixerEvent::Started {
                    id: incoming.id,
                    transition: Transition::Crossfade,
                });
                self.fading = self.current.replace(incoming);
                self.crossfade = Some(Crossfade {
                    len: remaining.max(1),
                    done: 0,
                });
                continue;
            }

            let want = frames - pos;
            if let Some(fade) = self.crossfade.as_ref() {
                let n = (want as u64).min(fade.len - fade.done) as usize;
                let (len, done) = (fade.len as f64, fade.done as f64);
                let gain_step = self.gain_step;
                let slice = &mut block[pos * 2..(pos + n) * 2];
                if let Some(old) = self.fading.as_mut() {
                    old.mix_into(
                        slice,
                        n,
                        |i| ((done + i as f64) / len * FRAC_PI_2).cos(),
                        gain_step,
                    );
                    if old.is_exhausted() {
                        self.end_fading();
                    }
                }
                let cur = self.current.as_mut().expect("current present");
                cur.mix_into(
                    slice,
                    n,
                    |i| ((done + i as f64) / len * FRAC_PI_2).sin(),
                    gain_step,
                );
                let fade = self.crossfade.as_mut().expect("fade present");
                fade.done += n as u64;
                pos += n;
                if fade.done >= fade.len {
                    // The old track is silent now (cos = 0); whatever is left of it is dropped.
                    self.crossfade = None;
                    self.end_fading();
                }
                continue;
            }

            let gain_step = self.gain_step;
            let cur = self.current.as_mut().expect("current present");
            let got = cur.mix_into(&mut block[pos * 2..], want, |_| 1.0, gain_step);
            if got > 0 && !cur.started {
                cur.started = true;
                let transition = cur.transition;
                self.emit(MixerEvent::Started {
                    id: cur_id,
                    transition,
                });
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
                } else if self
                    .current
                    .as_ref()
                    .is_some_and(|c| c.started || c.start_frame.is_some())
                    && !self.buffering
                {
                    self.buffering = true;
                    self.emit(MixerEvent::Buffering(true));
                }
                break;
            }
        }

        self.chain.process(&mut block);
        self.meters
            .record_peak(10f32.powf(self.chain.take_peak_db() / 20.0));
        self.write_output(&block);
        self.block = block;
        self.report_position(frames as u64);
    }

    /// The fading-out track of a crossfade has played to its end.
    fn end_fading(&mut self) {
        if let Some(old) = self.fading.take() {
            self.emit(MixerEvent::Ended {
                id: old.id,
                played_frames: old.consumed,
                completed: true,
            });
        }
    }

    fn finish_current(&mut self, completed: bool) {
        if let Some(cur) = self.current.take() {
            self.emit(MixerEvent::Ended {
                id: cur.id,
                played_frames: cur.consumed,
                completed,
            });
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
                self.emit(MixerEvent::Started {
                    id: next.id,
                    transition: next.transition,
                });
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
                dst.write(*src);
            }
            // SAFETY: every slot of the chunk was written above (block.len() == chunk length).
            unsafe { chunk.commit_all() };
            self.written += block.len() as u64;
        }
        if tap_enabled {
            let frames = block.len() / ENGINE_CHANNELS;
            if let Ok(mut chunk) = self.tap.write_chunk_uninit(frames.min(self.tap.slots())) {
                let (a, b) = chunk.as_mut_slices();
                for (dst, pair) in a
                    .iter_mut()
                    .chain(b.iter_mut())
                    .zip(block.as_chunks::<2>().0)
                {
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
        let Some(cur) = self.current.as_ref() else {
            return;
        };
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

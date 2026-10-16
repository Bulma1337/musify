//! The device-independent part of every output callback: pull interleaved stereo f32 from the ring,
//! apply the pause/play ramp, map to the device channel layout, handle underruns.
//!
//! Everything here is allocation-, lock- and log-free and runs inside real-time callbacks.

use std::sync::Arc;

use rtrb::Consumer;

use super::ramp::{Control, Ramp};
use crate::ENGINE_CHANNELS;

/// Writes one stereo frame into a device frame of `out.len()` channels:
/// mono gets `(L + R) / 2`, otherwise the first two channels get L/R and the rest silence.
#[inline]
pub fn map_stereo_frame(l: f32, r: f32, out: &mut [f32]) {
    match out.len() {
        0 => {}
        1 => out[0] = (l + r) * 0.5,
        _ => {
            out[0] = l;
            out[1] = r;
            out[2..].fill(0.0);
        }
    }
}

/// Converts interleaved stereo into interleaved `channels`-channel frames (see [`map_stereo_frame`]).
/// Processes `min(stereo frames, out frames)` frames.
pub fn map_stereo(stereo: &[f32], channels: usize, out: &mut [f32]) {
    for (src, dst) in stereo.as_chunks::<ENGINE_CHANNELS>().0.iter().zip(out.chunks_exact_mut(channels)) {
        map_stereo_frame(src[0], src[1], dst);
    }
}

/// How a render call treats a ring that holds fewer frames than requested.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillMode {
    /// A device: always fill the whole buffer, pad with silence and count an xrun.
    Device,
    /// Only produce frames backed by ring data (offline / test consumers). No xruns.
    Available,
}

/// Per-stream render state: ramp, underrun tracking. Owned by the callback.
pub struct Renderer {
    channels: usize,
    ramp: Ramp,
    control: Arc<Control>,
    /// Data has been received since the stream started / resumed (an empty ring before the first
    /// data is "not started yet", not an underrun).
    primed: bool,
    /// Inside an underrun episode (counted once, not once per callback).
    starved: bool,
}

impl Renderer {
    pub fn new(channels: u16, sample_rate: u32, control: Arc<Control>) -> Self {
        assert!(channels > 0, "device must have at least one channel");
        Self { channels: channels as usize, ramp: Ramp::for_rate(sample_rate), control, primed: false, starved: false }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn ramp(&self) -> &Ramp {
        &self.ramp
    }

    /// Fills all of `out` (interleaved, `channels` per frame). See [`FillMode::Device`].
    pub fn render(&mut self, ring: &mut Consumer<f32>, out: &mut [f32]) {
        self.render_with(ring, out, FillMode::Device);
    }

    /// Fills `out` and returns the number of frames produced (always all of them in
    /// [`FillMode::Device`]).
    pub fn render_with(&mut self, ring: &mut Consumer<f32>, out: &mut [f32], mode: FillMode) -> usize {
        let ch = self.channels;
        let total = out.len() / ch;
        if self.control.take_flush() {
            let queued = ring.slots();
            if queued > 0
                && let Ok(chunk) = ring.read_chunk(queued)
            {
                chunk.commit_all();
            }
        }
        // Read the ring fill level before the pause flag: a writer that sets `paused` and then pushes
        // data is then guaranteed to be seen as paused together with that data.
        let available = ring.slots() / ENGINE_CHANNELS;
        self.ramp.set_target(!self.control.is_paused());

        if self.ramp.is_silent() {
            self.primed = false;
            self.starved = false;
            return match mode {
                FillMode::Device => {
                    out[..total * ch].fill(0.0);
                    total
                }
                FillMode::Available => 0,
            };
        }

        // Frames that may consume ring data: all of them while playing, only up to the end of the
        // fade while pausing.
        let consume = total.min(self.ramp.frames_until_silent() as usize);
        let take = consume.min(available);

        let mut frame = 0;
        if take > 0 {
            let chunk = match ring.read_chunk(take * ENGINE_CHANNELS) {
                Ok(chunk) => chunk,
                Err(_) => unreachable!("read_chunk within slots() cannot fail"),
            };
            let (a, b) = chunk.as_slices();
            let mut samples = a.iter().chain(b.iter()).copied();
            while let (Some(l), Some(r)) = (samples.next(), samples.next()) {
                let dst = &mut out[frame * ch..(frame + 1) * ch];
                if self.ramp.is_unity() {
                    map_stereo_frame(l, r, dst);
                } else {
                    let g = self.ramp.step();
                    map_stereo_frame(l * g, r * g, dst);
                }
                frame += 1;
            }
            chunk.commit_all();
            self.primed = true;
            self.starved = false;
        }

        if mode == FillMode::Available {
            if self.ramp.is_silent() {
                self.primed = false;
            }
            return frame;
        }

        if take < consume {
            if self.primed && !self.starved {
                self.control.add_xrun();
                self.starved = true;
            }
            // Silence for the missing frames; the ramp keeps running in time.
            for _ in take..consume {
                if !self.ramp.is_unity() {
                    self.ramp.step();
                }
            }
        }
        out[frame * ch..total * ch].fill(0.0);
        if self.ramp.is_silent() {
            self.primed = false;
            self.starved = false;
        }
        total
    }
}

//! Navify's native audio engine.
//!
//! Pipeline (one engine instance per app):
//!
//! ```text
//! SourceManager ──bytes──► TrackWorker (decode → stereo f64 → resample to device rate) ──rtrb──┐
//!   (HTTP range cache,       one worker per loaded track: current + preloaded next          │
//!    local files)                                                                            ▼
//!                       Engine DSP thread: gapless/crossfade mix → per-track gain → DspChain ──rtrb f32──► Output
//!                                                                         └──mono tap──► SpectrumAnalyzer
//! ```
//!
//! Module ownership (see docs/AGENT-MODELS.md): `dsp`, `source`, `decode`, `output`, `analysis` are
//! independent and only talk through the types in [`api`] and the traits/structs in their `mod.rs`.
//! `engine` wires them together.

// Modules are being filled in parallel; remove once every module is implemented.
#![allow(dead_code)]

pub mod analysis;
pub mod api;
pub mod decode;
pub mod dsp;
pub mod engine;
pub mod output;
pub mod source;

/// The engine always works on interleaved stereo internally.
pub const ENGINE_CHANNELS: usize = 2;

pub use engine::{AudioEngine, EngineInit};

//! Public, serializable API of the engine: commands in, events out, and all configuration types.
//!
//! Everything here crosses the Tauri IPC boundary as JSON (camelCase), so changes must be mirrored in
//! the TypeScript types in `src/player/engine.ts`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Opaque track identity chosen by the UI (e.g. `"<serverId>:<trackId>"`).
pub type TrackId = String;

// ------------------------------------------------------------------------------------------------
// Sources
// ------------------------------------------------------------------------------------------------

/// Everything needed to play one track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSource {
    pub id: TrackId,
    pub location: SourceLocation,
    /// ReplayGain values from the server or tags; `None` = unknown (the engine may measure loudness).
    #[serde(default)]
    pub gain: Option<ReplayGainInfo>,
    /// Duration reported by the server, used until the decoder knows better.
    #[serde(default)]
    pub duration_hint_ms: Option<u64>,
    /// Tracks sharing an album key play gapless even when crossfade is on (if configured).
    #[serde(default)]
    pub album_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceLocation {
    /// A file on disk (offline download or local library).
    Local { path: PathBuf },
    /// A server stream. The URL may contain credentials: never log it, never use it as a cache key.
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<(String, String)>,
        /// Credential-free stable key (server + item + quality). Hashed for cache file names.
        cache_key: String,
        /// Server-side transcode: byte ranges may not be seekable.
        #[serde(default)]
        transcoded: bool,
        /// Expected container/extension, e.g. "flac", "mp3" (decoder probe hint).
        #[serde(default)]
        container_hint: Option<String>,
        /// How to restart a non-seekable transcode at an offset.
        #[serde(default)]
        time_offset: Option<TimeOffsetParam>,
        #[serde(default)]
        allow_insecure_tls: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOffsetParam {
    /// Query parameter name, e.g. `timeOffset` (Subsonic) or `StartTimeTicks` (Jellyfin).
    pub param: String,
    pub unit: TimeOffsetUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimeOffsetUnit {
    Seconds,
    /// 100 ns ticks (Jellyfin).
    Ticks,
}

/// ReplayGain 2.0 values (reference −18 LUFS).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGainInfo {
    pub track_gain_db: Option<f64>,
    pub album_gain_db: Option<f64>,
    /// Linear sample peak, 1.0 = 0 dBFS.
    pub track_peak: Option<f64>,
    pub album_peak: Option<f64>,
}

// ------------------------------------------------------------------------------------------------
// Playback settings
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizationMode {
    #[default]
    Off,
    Track,
    Album,
    /// Album gain while an album plays in order, track gain otherwise (decided by the UI per track).
    Auto,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoudnessTarget {
    /// −11 LUFS
    Loud,
    /// −14 LUFS
    #[default]
    Normal,
    /// −19 LUFS
    Quiet,
}

impl LoudnessTarget {
    pub fn lufs(self) -> f64 {
        match self {
            LoudnessTarget::Loud => -11.0,
            LoudnessTarget::Normal => -14.0,
            LoudnessTarget::Quiet => -19.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationConfig {
    pub mode: NormalizationMode,
    pub target: LoudnessTarget,
    /// Limit the applied gain so that `peak * gain <= 1.0` (when the peak is known).
    pub prevent_clipping: bool,
    /// Measure loudness (EBU R128) of files without ReplayGain tags once they are fully cached.
    pub analyze_untagged: bool,
}

impl Default for NormalizationConfig {
    fn default() -> Self {
        Self {
            mode: NormalizationMode::Off,
            target: LoudnessTarget::Normal,
            prevent_clipping: true,
            analyze_untagged: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossfadeConfig {
    /// 0 = gapless transition.
    pub duration_ms: u32,
    /// Keep consecutive tracks of the same album gapless (live albums, DJ mixes).
    pub skip_same_album: bool,
}

impl Default for CrossfadeConfig {
    fn default() -> Self {
        Self {
            duration_ms: 0,
            skip_same_album: true,
        }
    }
}

// ------------------------------------------------------------------------------------------------
// DSP / EQ
// ------------------------------------------------------------------------------------------------

/// Complete DSP configuration. Volume is separate (`EngineCommand::SetVolume`) because it changes often.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspConfig {
    pub eq: EqConfig,
    pub bass: BassEnhancerConfig,
    pub stereo: StereoConfig,
    /// Volume-dependent loudness compensation (ISO 226 inspired low/high shelf).
    pub loudness_compensation: bool,
    /// True-peak limiter at −1 dBTP. Should stay on whenever any gain > 0 dB can occur.
    pub limiter: bool,
}

impl DspConfig {
    /// True when the chain is mathematically a no-op (required for bit-perfect output).
    pub fn is_bypass(&self) -> bool {
        !self.eq.enabled
            && !self.bass.enabled
            && self.stereo.is_neutral()
            && !self.loudness_compensation
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqConfig {
    pub enabled: bool,
    /// Manual preamp in dB (−20…+20), applied before the filters.
    pub preamp_db: f64,
    /// Lower the preamp automatically by the maximum boost of the curve, so the EQ never clips.
    pub auto_headroom: bool,
    pub mode: EqMode,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            preamp_db: 0.0,
            auto_headroom: true,
            mode: EqMode::Graphic {
                bands: GraphicBands::Ten,
                gains_db: vec![0.0; 10],
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EqMode {
    /// Constant-Q graphic EQ at ISO center frequencies; the engine compensates band interaction so
    /// each slider value is what the response actually reaches at its center frequency.
    Graphic {
        bands: GraphicBands,
        gains_db: Vec<f64>,
    },
    Parametric {
        filters: Vec<ParametricFilter>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicBands {
    /// 31.5 Hz … 16 kHz, octave spacing.
    Ten,
    /// 20 Hz … 20 kHz, third-octave spacing.
    ThirtyOne,
}

impl GraphicBands {
    pub fn center_frequencies(self) -> &'static [f64] {
        match self {
            GraphicBands::Ten => &[
                31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
            ],
            GraphicBands::ThirtyOne => &[
                20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0,
                400.0, 500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0,
                5000.0, 6300.0, 8000.0, 10000.0, 12500.0, 16000.0, 20000.0,
            ],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParametricFilter {
    pub enabled: bool,
    pub kind: FilterKind,
    pub freq_hz: f64,
    /// Ignored for pass and notch filters.
    pub gain_db: f64,
    pub q: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Peaking,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
    Notch,
}

/// "Deep Bass": low shelf plus psychoacoustic harmonics so bass is audible on small speakers.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BassEnhancerConfig {
    pub enabled: bool,
    /// Low-shelf boost in dB (0…12).
    pub boost_db: f64,
    /// Shelf / crossover frequency in Hz (40…150).
    pub frequency_hz: f64,
    /// Amount of generated harmonics (0…1).
    pub harmonics: f64,
}

impl Default for BassEnhancerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            boost_db: 6.0,
            frequency_hz: 80.0,
            harmonics: 0.3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoConfig {
    /// Mid/side width: 0 = mono, 1 = unchanged, 2 = extra wide.
    pub width: f64,
    pub mono: bool,
    /// −1 = left only, 0 = center, 1 = right only (constant power).
    pub balance: f64,
}

impl Default for StereoConfig {
    fn default() -> Self {
        Self {
            width: 1.0,
            mono: false,
            balance: 0.0,
        }
    }
}

impl StereoConfig {
    pub fn is_neutral(&self) -> bool {
        (self.width - 1.0).abs() < 1e-9 && !self.mono && self.balance.abs() < 1e-9
    }
}

/// Frequency response of an EQ configuration, for drawing the curve in the UI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqResponse {
    /// Log-spaced frequencies in Hz.
    pub frequencies: Vec<f64>,
    /// Magnitude in dB including preamp, one value per frequency.
    pub magnitude_db: Vec<f64>,
    /// Highest boost of the filters alone (dB).
    pub max_boost_db: f64,
    /// Preamp the engine actually applies (manual preamp minus auto headroom).
    pub effective_preamp_db: f64,
}

// ------------------------------------------------------------------------------------------------
// Output
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Stable id that survives restarts (cpal `DeviceId` string).
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// Shared-mode mix rate.
    pub default_sample_rate: u32,
    pub max_channels: u16,
    /// Exclusive (bit-perfect) mode is possible on this device.
    pub supports_exclusive: bool,
    /// What the driver accepts in exclusive mode (`None` = not probed / not available).
    #[serde(default)]
    pub exclusive_caps: Option<ExclusiveCaps>,
}

/// Sample layout of a device stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceSampleFormat {
    Int16,
    /// Packed 3-byte samples.
    Int24,
    /// 24 valid bits in a 32-bit container.
    Int24In32,
    Int32,
    Float32,
    Float64,
    /// Anything else (8-bit, unsigned, 64-bit integer).
    Other,
}

impl DeviceSampleFormat {
    /// Significant bits per sample (the mantissa width + 1 for floats).
    pub fn valid_bits(self) -> u32 {
        match self {
            DeviceSampleFormat::Int16 => 16,
            DeviceSampleFormat::Int24 | DeviceSampleFormat::Int24In32 => 24,
            DeviceSampleFormat::Int32 => 32,
            DeviceSampleFormat::Float32 => 24,
            DeviceSampleFormat::Float64 => 53,
            DeviceSampleFormat::Other => 8,
        }
    }

    pub fn is_float(self) -> bool {
        matches!(
            self,
            DeviceSampleFormat::Float32 | DeviceSampleFormat::Float64
        )
    }

    /// Container size in bits (what the UI shows as "32 bit").
    pub fn container_bits(self) -> u32 {
        match self {
            DeviceSampleFormat::Int16 => 16,
            DeviceSampleFormat::Int24 => 24,
            DeviceSampleFormat::Int24In32
            | DeviceSampleFormat::Int32
            | DeviceSampleFormat::Float32 => 32,
            DeviceSampleFormat::Float64 => 64,
            DeviceSampleFormat::Other => 8,
        }
    }

    /// Every sample of a source with this resolution reaches the device unchanged.
    ///
    /// Integer sources need an integer format with at least as many bits; float sources need a
    /// float format at least as wide. Lossy sources (no bit depth) count as carried by float or
    /// ≥ 24-bit integer formats: their decoded output has no fixed grid, and rounding to 24 bits
    /// lies far below the codec's own noise.
    pub fn carries(self, source_bits: Option<u32>, source_float: bool) -> bool {
        match source_bits {
            Some(bits) if !source_float => !self.is_float() && self.valid_bits() >= bits,
            Some(bits) => self.is_float() && self.container_bits() >= bits,
            None => {
                self.is_float() || (self != DeviceSampleFormat::Other && self.valid_bits() >= 24)
            }
        }
    }
}

/// Exclusive-mode support of one device: every probed rate with the formats the driver accepts.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusiveCaps {
    /// Ascending by rate; rates without any accepted format are left out.
    pub modes: Vec<ExclusiveMode>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusiveMode {
    pub sample_rate: u32,
    /// In the engine's order of preference.
    pub formats: Vec<DeviceSampleFormat>,
}

impl ExclusiveCaps {
    pub fn is_empty(&self) -> bool {
        self.modes.is_empty()
    }

    pub fn rates(&self) -> impl Iterator<Item = u32> + '_ {
        self.modes.iter().map(|m| m.sample_rate)
    }

    pub fn formats_at(&self, rate: u32) -> &[DeviceSampleFormat] {
        self.modes
            .iter()
            .find(|m| m.sample_rate == rate)
            .map_or(&[], |m| &m.formats)
    }

    pub fn max_rate(&self) -> Option<u32> {
        self.rates().max()
    }

    /// Highest integer resolution (valid bits) at any rate.
    pub fn max_int_bits(&self) -> Option<u32> {
        self.modes
            .iter()
            .flat_map(|m| &m.formats)
            .filter(|f| !f.is_float() && **f != DeviceSampleFormat::Other)
            .map(|f| f.valid_bits())
            .max()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputConfig {
    /// `None` = follow the system default device.
    pub device_id: Option<String>,
    /// Request exclusive mode: the device is opened at each track's native rate (or the best rate
    /// it supports). DSP and volume still work; the output is bit-perfect only while they are
    /// neutral.
    pub exclusive: bool,
}

/// What actually reaches the device right now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFormat {
    pub device_name: String,
    /// Device rate. In shared mode this is the system mixer's rate.
    pub sample_rate: u32,
    pub channels: u16,
    pub exclusive: bool,
    /// Samples reach the device unchanged: exclusive, native rate, a sample format that holds the
    /// source exactly, DSP bypassed, volume 100 %, no normalization gain.
    pub bit_perfect: bool,
    /// Sample format of the stream (`None` = unknown). In shared mode the system mixer's format.
    #[serde(default)]
    pub sample_format: Option<DeviceSampleFormat>,
    /// Native rate of the current track (`None` = nothing loaded).
    #[serde(default)]
    pub source_rate: Option<u32>,
    /// The current track is resampled from `source_rate` to `sample_rate`.
    #[serde(default)]
    pub resampled: bool,
    /// Exclusive mode was requested but the device runs in shared mode; why.
    #[serde(default)]
    pub exclusive_fallback: Option<String>,
}

/// Properties of the decoded source, for the quality badge ("FLAC 24/96").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFormat {
    pub codec: String,
    pub sample_rate: u32,
    pub bits_per_sample: Option<u32>,
    pub channels: u16,
    pub bitrate_kbps: Option<u32>,
    pub lossless: bool,
    /// Floating-point PCM (e.g. 32-bit float WAV).
    #[serde(default)]
    pub float: bool,
}

// ------------------------------------------------------------------------------------------------
// Commands and events
// ------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EngineCommand {
    /// Start a track immediately (manual transition, replaces current and next).
    Play {
        track: TrackSource,
        start_ms: u64,
        paused: bool,
    },
    /// Set or clear the track that follows the current one (preloaded for gapless/crossfade).
    SetNext {
        track: Option<TrackSource>,
    },
    Pause,
    Resume,
    Stop,
    Seek {
        position_ms: u64,
    },
    /// Jump to the preloaded next track now.
    SkipToNext,
    /// UI volume 0.0…1.0 (mapped to a perceptual dB curve by the engine).
    SetVolume {
        volume: f64,
    },
    SetDsp {
        config: DspConfig,
    },
    SetNormalization {
        config: NormalizationConfig,
    },
    SetCrossfade {
        config: CrossfadeConfig,
    },
    SetOutput {
        config: OutputConfig,
    },
    /// Spectrum analyzer frames on/off (only computed while someone is watching).
    SetSpectrum {
        enabled: bool,
    },
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    Idle,
    Loading,
    Playing,
    Paused,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transition {
    Manual,
    Gapless,
    Crossfade,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Network,
    Decode,
    UnsupportedFormat,
    Output,
    Io,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EngineEvent {
    StateChanged {
        state: PlaybackState,
    },
    TrackStarted {
        id: TrackId,
        transition: Transition,
        duration_ms: Option<u64>,
        format: SourceFormat,
    },
    /// Sent 4–10 times per second while playing; the UI interpolates in between.
    Position {
        id: TrackId,
        position_ms: u64,
        duration_ms: Option<u64>,
        buffered_ms: Option<u64>,
    },
    Buffering {
        active: bool,
    },
    /// The current track ends soon and no next track is set.
    NeedNext {
        id: TrackId,
    },
    /// A track stopped being the current one (for listening history).
    TrackEnded {
        id: TrackId,
        played_ms: u64,
        completed: bool,
    },
    Error {
        id: Option<TrackId>,
        kind: ErrorKind,
        message: String,
        recoverable: bool,
    },
    OutputChanged {
        format: OutputFormat,
    },
    DeviceLost {
        fallback: Option<String>,
    },
}

/// One analyzer frame: `bands` log-spaced magnitudes quantized to 0…255 (0 = −90 dB, 255 = 0 dB).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumFrame {
    pub bands: Vec<u8>,
    /// Pre-limiter peak level in dBFS since the last frame (for the clip indicator).
    pub peak_db: f32,
}

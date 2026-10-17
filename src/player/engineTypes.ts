/**
 * TypeScript mirror of `src-tauri/crates/navify-audio/src/api.rs` (serde, camelCase, tagged enums).
 * Keep both files in sync.
 */

export type TimeOffsetUnit = "seconds" | "ticks";

export type SourceLocation =
  | { kind: "local"; path: string }
  | {
      kind: "http";
      url: string;
      headers: [string, string][];
      cacheKey: string;
      transcoded: boolean;
      containerHint: string | null;
      timeOffset: { param: string; unit: TimeOffsetUnit } | null;
      allowInsecureTls: boolean;
    };

export interface ReplayGainInfo {
  trackGainDb: number | null;
  albumGainDb: number | null;
  trackPeak: number | null;
  albumPeak: number | null;
}

export interface TrackSource {
  id: string;
  location: SourceLocation;
  gain: ReplayGainInfo | null;
  durationHintMs: number | null;
  albumKey: string | null;
}

export type NormalizationMode = "off" | "track" | "album" | "auto";
export type LoudnessTarget = "loud" | "normal" | "quiet";

export interface NormalizationConfig {
  mode: NormalizationMode;
  target: LoudnessTarget;
  preventClipping: boolean;
  analyzeUntagged: boolean;
}

export interface CrossfadeConfig {
  durationMs: number;
  skipSameAlbum: boolean;
}

export type FilterKind = "peaking" | "lowShelf" | "highShelf" | "lowPass" | "highPass" | "notch";
export type GraphicBands = "ten" | "thirtyOne";

export interface ParametricFilter {
  enabled: boolean;
  kind: FilterKind;
  freqHz: number;
  gainDb: number;
  q: number;
}

export type EqMode =
  | { type: "graphic"; bands: GraphicBands; gainsDb: number[] }
  | { type: "parametric"; filters: ParametricFilter[] };

export interface EqConfig {
  enabled: boolean;
  preampDb: number;
  autoHeadroom: boolean;
  mode: EqMode;
}

export interface BassEnhancerConfig {
  enabled: boolean;
  boostDb: number;
  frequencyHz: number;
  harmonics: number;
}

export interface StereoConfig {
  width: number;
  mono: boolean;
  balance: number;
}

export interface DspConfig {
  eq: EqConfig;
  bass: BassEnhancerConfig;
  stereo: StereoConfig;
  loudnessCompensation: boolean;
  limiter: boolean;
}

export interface EqResponse {
  frequencies: number[];
  magnitudeDb: number[];
  maxBoostDb: number;
  effectivePreampDb: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  defaultSampleRate: number;
  maxChannels: number;
  supportsExclusive: boolean;
}

export interface OutputConfig {
  deviceId: string | null;
  exclusive: boolean;
}

export interface OutputFormat {
  deviceName: string;
  sampleRate: number;
  channels: number;
  exclusive: boolean;
  bitPerfect: boolean;
}

export interface SourceFormat {
  codec: string;
  sampleRate: number;
  bitsPerSample: number | null;
  channels: number;
  bitrateKbps: number | null;
  lossless: boolean;
}

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "stopped";
export type Transition = "manual" | "gapless" | "crossfade";
export type ErrorKind = "network" | "decode" | "unsupportedFormat" | "output" | "io" | "other";

export type EngineCommand =
  | { type: "play"; track: TrackSource; startMs: number; paused: boolean }
  | { type: "setNext"; track: TrackSource | null }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "seek"; positionMs: number }
  | { type: "skipToNext" }
  | { type: "setVolume"; volume: number }
  | { type: "setDsp"; config: DspConfig }
  | { type: "setNormalization"; config: NormalizationConfig }
  | { type: "setCrossfade"; config: CrossfadeConfig }
  | { type: "setOutput"; config: OutputConfig }
  | { type: "setSpectrum"; enabled: boolean };

export type EngineEvent =
  | { type: "stateChanged"; state: PlaybackState }
  | {
      type: "trackStarted";
      id: string;
      transition: Transition;
      durationMs: number | null;
      format: SourceFormat;
    }
  | { type: "position"; id: string; positionMs: number; durationMs: number | null; bufferedMs: number | null }
  | { type: "buffering"; active: boolean }
  | { type: "needNext"; id: string }
  | { type: "trackEnded"; id: string; playedMs: number; completed: boolean }
  | { type: "error"; id: string | null; kind: ErrorKind; message: string; recoverable: boolean }
  | { type: "outputChanged"; format: OutputFormat }
  | { type: "deviceLost"; fallback: string | null };

export interface SpectrumFrame {
  bands: number[];
  peakDb: number;
}

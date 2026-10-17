import type { EqPreset } from "@/settings/store";
import type { BassEnhancerConfig, DspConfig, EqConfig } from "@/player/engineTypes";
import { resampleGraphicGains } from "./eqMath";

/** Octave-band gains in dB for 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz. */
type TenBandGains = [number, number, number, number, number, number, number, number, number, number];

export interface BuiltInPreset {
  /** Stable id; the display name is `equalizer.presetNames.<id>`. */
  id: string;
  gainsDb: TenBandGains;
  /** Presets without this turn the bass enhancer off (keeping the user's values). */
  bass?: Pick<BassEnhancerConfig, "boostDb" | "frequencyHz" | "harmonics">;
}

/**
 * Built-in curves. They are starting points for listening on typical headphones and speakers, kept
 * within ±8 dB so that auto headroom costs little level.
 */
export const BUILT_IN_PRESETS: readonly BuiltInPreset[] = [
  { id: "flat", gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  {
    // Gentle low-end lift plus the bass enhancer's harmonics for weight on small drivers.
    id: "deepBass",
    gainsDb: [3, 3, 2, 0.5, 0, 0, 0, 0, 0, 0],
    bass: { boostDb: 6, frequencyHz: 80, harmonics: 0.4 },
  },
  { id: "bassBooster", gainsDb: [6, 5.5, 4, 2, 0.5, 0, 0, 0, 0, 0] },
  { id: "bassReducer", gainsDb: [-6, -5, -3.5, -1.5, 0, 0, 0, 0, 0, 0] },
  { id: "vShape", gainsDb: [5, 4, 2, -1, -3, -3, -1, 2, 4.5, 5] },
  {
    // Low shelf lift, an open presence region and a little taken off the top: a common
    // "target curve" shape for headphones that measure close to flat.
    id: "headphoneTarget",
    gainsDb: [5, 4.5, 2, 0, -0.5, 0, 1, 2.5, -1, -2],
  },
  { id: "vocal", gainsDb: [-3, -2.5, -1.5, 0, 1.5, 3, 3.5, 2.5, 0.5, 0] },
  { id: "acoustic", gainsDb: [4, 3.5, 2.5, 0.5, 1, 1, 2, 2.5, 3, 2] },
  { id: "classical", gainsDb: [2, 1.5, 1, 0.5, 0, 0, 0, 1, 2, 2.5] },
  { id: "electronic", gainsDb: [5, 4.5, 1.5, 0, -2, 2, 0.5, 1.5, 4.5, 5] },
  { id: "hipHop", gainsDb: [5.5, 5, 2.5, 3, -1, -1, 1.5, -0.5, 2, 3] },
  { id: "rock", gainsDb: [5, 4, 2.5, 1, -1, -1.5, 0.5, 2.5, 3.5, 4] },
  { id: "metal", gainsDb: [4.5, 3.5, 0, 1.5, -1.5, -2.5, 0, 2, 4, 4.5] },
  { id: "pop", gainsDb: [-1.5, -0.5, 1.5, 3, 3.5, 3, 1.5, 0, -0.5, -1.5] },
  { id: "jazz", gainsDb: [2.5, 2, 1, 2, -1, -1, 0, 1.5, 2.5, 3] },
  { id: "dance", gainsDb: [6, 5, 3, 0.5, 0, -1.5, -1, 0, 3, 3.5] },
  // Roughly the inverse of the ear's reduced low/high sensitivity at low listening levels.
  { id: "loudness", gainsDb: [6, 4.5, 1.5, 0, -1, -1, 0, 1, 3.5, 5] },
  { id: "trebleBooster", gainsDb: [0, 0, 0, 0, 0, 1, 2.5, 4, 5.5, 6] },
  { id: "trebleReducer", gainsDb: [0, 0, 0, 0, 0, -1, -2.5, -4, -5.5, -6] },
  // Quiet listening: less low-end rumble and sibilance, mids stay clear.
  { id: "lateNight", gainsDb: [-4, -3, -1.5, 0, 1, 1.5, 1, -0.5, -2, -3.5] },
  {
    // Drivers that cannot reproduce the deep bass: cut it and let harmonics suggest it instead.
    id: "smallSpeakers",
    gainsDb: [-8, -6, -2, 2.5, 2, 1, 1.5, 2.5, 2, 0.5],
    bass: { boostDb: 2, frequencyHz: 120, harmonics: 0.6 },
  },
  { id: "speech", gainsDb: [-8, -6, -3, -0.5, 1.5, 3, 3.5, 2, -1, -3] },
];

export const isBuiltInPresetId = (id: string | null): boolean =>
  id !== null && BUILT_IN_PRESETS.some((p) => p.id === id);

export const getBuiltInPreset = (id: string | null): BuiltInPreset | undefined =>
  BUILT_IN_PRESETS.find((p) => p.id === id);

/** The configuration a built-in preset produces, adapted to the user's current band layout. */
export function builtInPresetDsp(
  preset: BuiltInPreset,
  current: Pick<DspConfig, "eq" | "bass" | "loudnessCompensation">,
): EqPreset["dsp"] {
  const mode = current.eq.mode;
  const bands = mode.type === "graphic" ? mode.bands : "ten";
  const eq: EqConfig = {
    enabled: true,
    preampDb: 0,
    autoHeadroom: true,
    mode: {
      type: "graphic",
      bands,
      gainsDb: bands === "ten" ? [...preset.gainsDb] : resampleGraphicGains(preset.gainsDb, "ten", bands),
    },
  };
  const bass: BassEnhancerConfig = preset.bass
    ? { enabled: true, ...preset.bass }
    : { ...current.bass, enabled: false };
  // Loudness compensation depends on the listening level, not on the curve: leave it alone.
  return { eq, bass, loudnessCompensation: current.loudnessCompensation };
}

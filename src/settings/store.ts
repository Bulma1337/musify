import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { StreamQuality } from "@/api/provider";
import { readPersisted, writePersisted } from "@/lib/persist";
import type { CrossfadeConfig, DspConfig, NormalizationConfig, OutputConfig } from "@/player/engineTypes";

export type AccentColor = "purple" | "blue" | "red" | "dynamic";

/** Streaming quality presets shown in Settings → Audio quality. */
export type QualityPreset = "original" | "high" | "normal" | "low";

export const QUALITY_PRESETS: Record<QualityPreset, StreamQuality> = {
  original: {},
  high: { maxBitRateKbps: 320, format: "opus" },
  normal: { maxBitRateKbps: 192, format: "opus" },
  low: { maxBitRateKbps: 96, format: "opus" },
};

export interface EqPreset {
  id: string;
  name: string;
  dsp: Pick<DspConfig, "eq" | "bass" | "loudnessCompensation">;
}

/** Engine defaults: everything off so playback can stay bit-perfect. */
export const DEFAULT_DSP: DspConfig = {
  eq: {
    enabled: false,
    preampDb: 0,
    autoHeadroom: true,
    mode: { type: "graphic", bands: "ten", gainsDb: Array(10).fill(0) },
  },
  bass: { enabled: false, boostDb: 6, frequencyHz: 80, harmonics: 0.3 },
  stereo: { width: 1, mono: false, balance: 0 },
  loudnessCompensation: false,
  // Off by default: a limiter changes loud masters and would break bit-perfect output. EQ auto
  // headroom and normalization's clipping protection already prevent overs.
  limiter: false,
};

interface SettingsState {
  streamingQuality: QualityPreset;
  downloadQuality: QualityPreset;
  normalization: NormalizationConfig;
  crossfade: CrossfadeConfig;
  dsp: DspConfig;
  output: OutputConfig;
  /** Selected EQ preset (built-in or custom id), null = custom curve. */
  eqPresetId: string | null;
  customPresets: EqPreset[];
  accent: AccentColor;

  set<K extends keyof Omit<SettingsState, "set" | "updateDsp">>(key: K, value: SettingsState[K]): void;
  updateDsp(change: (dsp: DspConfig) => DspConfig): void;
}

/** plugin-store in the app, localStorage in the browser preview (via persist.ts). */
const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("settings.json", name)) ?? null,
  setItem: (name, value) => writePersisted("settings.json", name, value),
  removeItem: (name) => writePersisted("settings.json", name, null),
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      streamingQuality: "original",
      downloadQuality: "original",
      normalization: { mode: "off", target: "normal", preventClipping: true, analyzeUntagged: true },
      crossfade: { durationMs: 0, skipSameAlbum: true },
      dsp: DEFAULT_DSP,
      output: { deviceId: null, exclusive: false },
      eqPresetId: null,
      customPresets: [],
      accent: "purple",

      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      updateDsp: (change) => set((s) => ({ dsp: change(s.dsp) })),
    }),
    {
      name: "navify.settings",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: ({ set: _set, updateDsp: _update, ...data }) => data,
    },
  ),
);

/** The stream quality the player should request for the current setting. */
export function currentStreamQuality(): StreamQuality {
  return QUALITY_PRESETS[useSettings.getState().streamingQuality];
}

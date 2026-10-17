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

/** Choices for the streaming cache size (Settings → Storage). */
export const CACHE_LIMITS_GB = [1, 2, 5, 10] as const;

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
  /** "balanced" = fewer artist repeats, "random" = plain shuffle. */
  shuffleAlgorithm: "balanced" | "random";
  /** Continue with similar tracks when the queue ends. */
  autoplay: boolean;
  /**
   * Continue exactly where playback stopped (after closing the app or on another device) if that was
   * at most this many minutes ago; 0 = never resume playing by itself.
   */
  resumeWindowMin: number;
  /** Save the play queue on the server so other devices (and this one) can continue it. */
  syncPlayQueue: boolean;
  /** Look for new versions and download them in the background. */
  autoUpdate: boolean;
  /** Look up missing lyrics on LRCLIB (sends title, artist and album there). */
  onlineLyrics: boolean;
  /** Closing the window hides it to the tray; playback continues. */
  closeToTray: boolean;
  /** Desktop notification when a new track starts while the app is in the background. */
  notifyTrackChange: boolean;
  streamingQuality: QualityPreset;
  downloadQuality: QualityPreset;
  /** Size limit of the audio streaming cache in GB: one of `CACHE_LIMITS_GB`. */
  cacheLimitGb: number;
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
      shuffleAlgorithm: "balanced",
      autoplay: true,
      resumeWindowMin: 10,
      syncPlayQueue: true,
      autoUpdate: true,
      onlineLyrics: true,
      closeToTray: false,
      notifyTrackChange: false,
      streamingQuality: "original",
      downloadQuality: "original",
      cacheLimitGb: 2,
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
      name: "musify.settings",
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

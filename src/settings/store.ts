import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { StreamQuality } from "@/api/provider";
import { readPersisted, writePersisted } from "@/lib/persist";
import type { CrossfadeConfig, DspConfig, NormalizationConfig, OutputConfig } from "@/player/engineTypes";
import { accentPreset, DEFAULT_ACCENT, type AccentId } from "./accentPresets";
import {
  DEFAULT_AUTO_PLAYLISTS,
  DEFAULT_HOME_SECTIONS,
  normalizeHomeSections,
  type AutoPlaylistPrefs,
  type HomeSectionPref,
} from "./homeLayout";

/** An id from ACCENT_PRESETS (src/settings/accentPresets.ts). */
export type AccentColor = AccentId;

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
  /** Show the playing track in Discord. */
  discordPresence: boolean;
  /** Look up a public album cover for Discord (sends artist and album to Deezer's and Apple's search). */
  discordCovers: boolean;
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
  /** Home page rows below the quick-access grid: order and visibility. */
  homeSections: HomeSectionPref[];
  autoPlaylists: AutoPlaylistPrefs;

  set<K extends keyof Omit<SettingsState, "set" | "updateDsp">>(key: K, value: SettingsState[K]): void;
  updateDsp(change: (dsp: DspConfig) => DspConfig): void;
}

/** plugin-store in the app, localStorage in the browser preview (via persist.ts). */
const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("settings.json", name)) ?? null,
  setItem: (name, value) => writePersisted("settings.json", name, value),
  removeItem: (name) => writePersisted("settings.json", name, null),
};

/**
 * Older saved settings.
 * - v2: crossfade applies within albums too. Version 1 kept album tracks gapless by default, so
 *   crossfade seemed not to work when listening to an album.
 * - v3: the accent no longer follows the cover ("dynamic" becomes the default accent), and unknown
 *   accent ids fall back to it as well.
 * - v4: Glut ("ember") is the new brand color and default. The old purple default and the presets
 *   dropped from the new set are unknown ids now, so they switch to it.
 */
export function migrateSettings(persisted: unknown, version: number): SettingsState {
  const state = (persisted ?? {}) as Partial<SettingsState>;
  if (version < 2 && state.crossfade) {
    state.crossfade = { ...state.crossfade, skipSameAlbum: false };
  }
  if (version < 4 && state.accent !== undefined) {
    state.accent = accentPreset(state.accent).id;
  }
  if (state.homeSections) state.homeSections = normalizeHomeSections(state.homeSections);
  return state as SettingsState;
}

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
      discordPresence: true,
      discordCovers: true,
      streamingQuality: "original",
      downloadQuality: "original",
      cacheLimitGb: 2,
      normalization: { mode: "off", target: "normal", preventClipping: true, analyzeUntagged: true },
      crossfade: { durationMs: 0, skipSameAlbum: false },
      dsp: DEFAULT_DSP,
      output: { deviceId: null, exclusive: false },
      eqPresetId: null,
      customPresets: [],
      accent: DEFAULT_ACCENT,
      homeSections: DEFAULT_HOME_SECTIONS,
      autoPlaylists: DEFAULT_AUTO_PLAYLISTS,

      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      updateDsp: (change) => set((s) => ({ dsp: change(s.dsp) })),
    }),
    {
      name: "musify.settings",
      version: 4,
      storage: createJSONStorage(() => storage),
      migrate: migrateSettings,
      partialize: ({ set: _set, updateDsp: _update, ...data }) => data,
    },
  ),
);

/** The stream quality the player should request for the current setting. */
export function currentStreamQuality(): StreamQuality {
  return QUALITY_PRESETS[useSettings.getState().streamingQuality];
}

import type { BassEnhancerConfig, EqMode, FilterKind, ParametricFilter } from "@/player/engineTypes";
import type { EqPreset } from "@/settings/store";
import { GRAPHIC_FREQUENCIES, MAX_PARAMETRIC_FILTERS } from "./eqMath";

const FORMAT_TAG = "eq-preset";
const FORMAT_VERSION = 1;
const FILTER_KINDS: readonly FilterKind[] = [
  "peaking",
  "lowShelf",
  "highShelf",
  "lowPass",
  "highPass",
  "notch",
];

export interface SharedPreset {
  name: string;
  dsp: EqPreset["dsp"];
}

/** Thrown for text that is not a usable preset; the message is for developers, the UI shows a generic one. */
export class PresetParseError extends Error {}

/** JSON text of a preset for copying to the clipboard. */
export function serializePreset(name: string, dsp: EqPreset["dsp"]): string {
  return JSON.stringify({ navify: FORMAT_TAG, version: FORMAT_VERSION, name, dsp }, null, 2);
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function number(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PresetParseError(`${what} is not a number`);
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new PresetParseError(`${what} is not a boolean`);
  return value;
}

function parseFilter(raw: unknown): ParametricFilter {
  if (!isObject(raw)) throw new PresetParseError("filter is not an object");
  const kind = raw.kind;
  if (typeof kind !== "string" || !FILTER_KINDS.includes(kind as FilterKind)) {
    throw new PresetParseError("unknown filter type");
  }
  return {
    enabled: bool(raw.enabled, "filter.enabled"),
    kind: kind as FilterKind,
    freqHz: number(raw.freqHz, 20, 20_000, "filter.freqHz"),
    gainDb: number(raw.gainDb ?? 0, -24, 24, "filter.gainDb"),
    q: number(raw.q, 0.1, 100, "filter.q"),
  };
}

function parseMode(raw: unknown): EqMode {
  if (!isObject(raw)) throw new PresetParseError("eq.mode is not an object");
  if (raw.type === "graphic") {
    const bands = raw.bands;
    if (bands !== "ten" && bands !== "thirtyOne") throw new PresetParseError("unknown band layout");
    if (!Array.isArray(raw.gainsDb)) throw new PresetParseError("gainsDb is not a list");
    const rawGains: unknown[] = raw.gainsDb;
    const gainsDb = GRAPHIC_FREQUENCIES[bands].map((_, i) =>
      rawGains[i] === undefined ? 0 : Math.round(number(rawGains[i], -24, 24, "gain") * 10) / 10,
    );
    return { type: "graphic", bands, gainsDb };
  }
  if (raw.type === "parametric") {
    if (!Array.isArray(raw.filters)) throw new PresetParseError("filters is not a list");
    return { type: "parametric", filters: raw.filters.slice(0, MAX_PARAMETRIC_FILTERS).map(parseFilter) };
  }
  throw new PresetParseError("unknown EQ mode");
}

function parseDsp(raw: unknown): EqPreset["dsp"] {
  if (!isObject(raw) || !isObject(raw.eq) || !isObject(raw.bass))
    throw new PresetParseError("dsp is incomplete");
  const bass: BassEnhancerConfig = {
    enabled: bool(raw.bass.enabled, "bass.enabled"),
    boostDb: number(raw.bass.boostDb, 0, 12, "bass.boostDb"),
    frequencyHz: number(raw.bass.frequencyHz, 40, 150, "bass.frequencyHz"),
    harmonics: number(raw.bass.harmonics, 0, 1, "bass.harmonics"),
  };
  return {
    eq: {
      enabled: true,
      preampDb: number(raw.eq.preampDb ?? 0, -20, 20, "eq.preampDb"),
      autoHeadroom: bool(raw.eq.autoHeadroom ?? true, "eq.autoHeadroom"),
      mode: parseMode(raw.eq.mode),
    },
    bass,
    loudnessCompensation: raw.loudnessCompensation === true,
  };
}

/**
 * Parses pasted preset JSON (one preset or a list). Values are validated and clamped; unknown fields
 * are dropped. Throws `PresetParseError` for anything that is not a preset.
 */
export function parsePresets(text: string): SharedPreset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PresetParseError("not valid JSON");
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.length === 0) throw new PresetParseError("empty list");
  return list.map((entry) => {
    if (!isObject(entry) || entry.navify !== FORMAT_TAG) throw new PresetParseError("not a Navify preset");
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 60) : "";
    return { name, dsp: parseDsp(entry.dsp) };
  });
}

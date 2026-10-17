import type { BassEnhancerConfig, DspConfig, EqConfig, ParametricFilter } from "@/player/engineTypes";
import { useSettings, type EqPreset } from "@/settings/store";
import { MAX_PARAMETRIC_FILTERS, resampleGraphicGains, solveGraphicFilters } from "./eqMath";
import { builtInPresetDsp, getBuiltInPreset, isBuiltInPresetId } from "./presets";

/**
 * All changes the equalizer page makes to the settings store. The engine follows the store
 * (`settings/engineSync.ts`), so nothing here talks to the engine.
 */

export type EqModeChoice = "ten" | "thirtyOne" | "parametric";
export type PresetDsp = EqPreset["dsp"];

// The parametric filter list and the last graphic curve survive switching tabs (this session).
let parametricMemory: ParametricFilter[] | null = null;
let graphicMemory: { bands: "ten" | "thirtyOne"; gainsDb: number[] } | null = null;

const state = () => useSettings.getState();
const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The user changed the sound. A built-in preset no longer describes it; a custom one shows "modified". */
function markEdited() {
  const s = state();
  if (isBuiltInPresetId(s.eqPresetId)) s.set("eqPresetId", null);
}

function editEq(change: (eq: EqConfig) => EqConfig) {
  state().updateDsp((dsp) => ({ ...dsp, eq: change(dsp.eq) }));
  markEdited();
}

/** Forgets the remembered parametric filters and graphic curve (they only live for the session). */
export function clearEqMemory() {
  parametricMemory = null;
  graphicMemory = null;
}

export function defaultParametricFilters(): ParametricFilter[] {
  return [60, 250, 1000, 4000, 12_000].map((freqHz) => ({
    enabled: true,
    kind: "peaking" as const,
    freqHz,
    gainDb: 0,
    q: 1,
  }));
}

/** Parametric filters that sound like the given graphic curve (empty curve → neutral starter filters). */
export function filtersFromGraphic(
  bands: "ten" | "thirtyOne",
  gainsDb: readonly number[],
): ParametricFilter[] {
  const toFilters = (b: "ten" | "thirtyOne", gains: readonly number[]) =>
    solveGraphicFilters(b, gains)
      .map((f) => ({
        enabled: true,
        kind: "peaking" as const,
        freqHz: f.freqHz,
        gainDb: round1(f.gainDb),
        q: f.q,
      }))
      .filter((f) => Math.abs(f.gainDb) >= 0.1);
  let filters = toFilters(bands, gainsDb);
  if (filters.length > MAX_PARAMETRIC_FILTERS && bands === "thirtyOne") {
    filters = toFilters("ten", resampleGraphicGains(gainsDb, "thirtyOne", "ten"));
  }
  return filters.length > 0 ? filters : defaultParametricFilters();
}

export function setEqEnabled(enabled: boolean) {
  state().updateDsp((dsp) => ({ ...dsp, eq: { ...dsp.eq, enabled } }));
}

export function setEqMode(target: EqModeChoice) {
  editEq((eq) => {
    const current = eq.mode;
    if (target === "parametric") {
      if (current.type === "parametric") return eq;
      graphicMemory = { bands: current.bands, gainsDb: current.gainsDb };
      const filters = parametricMemory ?? filtersFromGraphic(current.bands, current.gainsDb);
      return { ...eq, mode: { type: "parametric", filters } };
    }
    if (current.type === "parametric") {
      parametricMemory = current.filters;
      const remembered = graphicMemory?.bands === target ? graphicMemory.gainsDb : null;
      const gainsDb =
        remembered ??
        (graphicMemory
          ? resampleGraphicGains(graphicMemory.gainsDb, graphicMemory.bands, target)
          : new Array<number>(target === "ten" ? 10 : 31).fill(0));
      return { ...eq, mode: { type: "graphic", bands: target, gainsDb } };
    }
    if (current.bands === target) return eq;
    return {
      ...eq,
      mode: {
        type: "graphic",
        bands: target,
        gainsDb: resampleGraphicGains(current.gainsDb, current.bands, target),
      },
    };
  });
}

export function setGraphicGain(index: number, gainDb: number) {
  editEq((eq) => {
    if (eq.mode.type !== "graphic") return eq;
    const gainsDb = eq.mode.gainsDb.slice();
    gainsDb[index] = round1(clamp(gainDb, -12, 12));
    return { ...eq, mode: { ...eq.mode, gainsDb } };
  });
}

export function setPreamp(preampDb: number) {
  editEq((eq) => ({ ...eq, preampDb: round1(clamp(preampDb, -20, 20)) }));
}

export function setAutoHeadroom(autoHeadroom: boolean) {
  editEq((eq) => ({ ...eq, autoHeadroom }));
}

function editFilters(change: (filters: ParametricFilter[]) => ParametricFilter[]) {
  editEq((eq) =>
    eq.mode.type === "parametric"
      ? { ...eq, mode: { type: "parametric", filters: change(eq.mode.filters) } }
      : eq,
  );
}

export function updateFilter(index: number, patch: Partial<ParametricFilter>) {
  editFilters((filters) => filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
}

export function addFilter(filter?: Partial<ParametricFilter>) {
  editFilters((filters) =>
    filters.length >= MAX_PARAMETRIC_FILTERS
      ? filters
      : [...filters, { enabled: true, kind: "peaking", freqHz: 1000, gainDb: 0, q: 1, ...filter }],
  );
}

export function removeFilter(index: number) {
  editFilters((filters) => filters.filter((_, i) => i !== index));
}

export function updateBass(patch: Partial<BassEnhancerConfig>) {
  state().updateDsp((dsp) => ({ ...dsp, bass: { ...dsp.bass, ...patch } }));
  markEdited();
}

export function setLoudnessCompensation(on: boolean) {
  state().updateDsp((dsp) => ({ ...dsp, loudnessCompensation: on }));
}

export function setLimiter(on: boolean) {
  state().updateDsp((dsp) => ({ ...dsp, limiter: on }));
}

/** Flat curve in the current layout, preamp 0 dB, automatic headroom on. The bass enhancer stays as it is. */
export function resetEq() {
  const s = state();
  const mode = s.dsp.eq.mode;
  clearEqMemory();
  s.updateDsp((dsp) => ({
    ...dsp,
    eq: {
      ...dsp.eq,
      preampDb: 0,
      autoHeadroom: true,
      mode:
        mode.type === "graphic"
          ? { type: "graphic", bands: mode.bands, gainsDb: mode.gainsDb.map(() => 0) }
          : { type: "parametric", filters: defaultParametricFilters() },
    },
  }));
  s.set("eqPresetId", mode.type === "graphic" && !s.dsp.bass.enabled ? "flat" : null);
}

/** What a preset stores: the whole EQ setup. */
export function snapshotDsp(dsp: DspConfig): PresetDsp {
  return {
    eq: { ...dsp.eq, enabled: true },
    bass: dsp.bass,
    loudnessCompensation: dsp.loudnessCompensation,
  };
}

export function findPreset(id: string | null): { name?: string; custom?: EqPreset; builtIn: boolean } | null {
  if (id === null) return null;
  if (getBuiltInPreset(id)) return { builtIn: true };
  const custom = state().customPresets.find((p) => p.id === id);
  return custom ? { name: custom.name, custom, builtIn: false } : null;
}

/** Applies a built-in or custom preset and turns the EQ on. Built-ins follow the current band layout. */
export function applyPreset(id: string) {
  const s = state();
  const builtIn = getBuiltInPreset(id);
  const dsp = builtIn ? builtInPresetDsp(builtIn, s.dsp) : s.customPresets.find((p) => p.id === id)?.dsp;
  if (!dsp) return;
  parametricMemory = dsp.eq.mode.type === "parametric" ? dsp.eq.mode.filters : parametricMemory;
  s.updateDsp((current) => ({
    ...current,
    eq: { ...dsp.eq, enabled: true },
    bass: dsp.bass,
    loudnessCompensation: dsp.loudnessCompensation,
  }));
  s.set("eqPresetId", id);
}

/** True when the current setup differs from what the selected custom preset stores. */
export function isPresetModified(preset: EqPreset, dsp: DspConfig): boolean {
  return (
    stableJson(snapshotDsp(dsp)) !== stableJson({ ...preset.dsp, eq: { ...preset.dsp.eq, enabled: true } })
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function newPresetId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Adds presets to the custom list (selecting the last one) and applies it. */
export function addCustomPresets(items: { name: string; dsp: PresetDsp }[]) {
  const s = state();
  const created: EqPreset[] = items.map((item) => ({ id: newPresetId(), name: item.name, dsp: item.dsp }));
  s.set("customPresets", [...s.customPresets, ...created]);
  const last = created[created.length - 1];
  if (last) applyPreset(last.id);
}

export function saveCurrentAsPreset(name: string) {
  addCustomPresets([{ name, dsp: snapshotDsp(state().dsp) }]);
}

export function overwritePreset(id: string) {
  const s = state();
  s.set(
    "customPresets",
    s.customPresets.map((p) => (p.id === id ? { ...p, dsp: snapshotDsp(s.dsp) } : p)),
  );
}

export function renamePreset(id: string, name: string) {
  const s = state();
  s.set(
    "customPresets",
    s.customPresets.map((p) => (p.id === id ? { ...p, name } : p)),
  );
}

export function deletePreset(id: string) {
  const s = state();
  s.set(
    "customPresets",
    s.customPresets.filter((p) => p.id !== id),
  );
  if (s.eqPresetId === id) s.set("eqPresetId", null);
}

/** Uses an imported (AutoEQ) configuration: parametric mode, EQ on, no preset selected. */
export function applyImportedEq(eq: EqConfig) {
  const s = state();
  parametricMemory = eq.mode.type === "parametric" ? eq.mode.filters : parametricMemory;
  s.updateDsp((dsp) => ({ ...dsp, eq: { ...eq, enabled: true } }));
  s.set("eqPresetId", null);
}

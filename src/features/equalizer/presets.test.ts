import { DEFAULT_DSP, useSettings } from "@/settings/store";
import {
  applyPreset,
  clearEqMemory,
  filtersFromGraphic,
  isPresetModified,
  saveCurrentAsPreset,
  setEqMode,
  snapshotDsp,
} from "./eqActions";
import { GRAPHIC_FREQUENCIES } from "./eqMath";
import de from "./locales/de.json";
import en from "./locales/en.json";
import { BUILT_IN_PRESETS, builtInPresetDsp } from "./presets";
import { parsePresets, PresetParseError, serializePreset } from "./presetsIo";

beforeEach(() => {
  clearEqMemory();
  useSettings.setState({ dsp: structuredClone(DEFAULT_DSP), eqPresetId: null, customPresets: [] });
});

describe("built-in presets", () => {
  it("define all 22 presets with 10 octave gains inside the slider range and a German and English name", () => {
    expect(BUILT_IN_PRESETS).toHaveLength(22);
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size).toBe(22);
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset.gainsDb).toHaveLength(10);
      expect(preset.gainsDb.every((g) => Math.abs(g) <= 12)).toBe(true);
      expect(en.equalizer.presetNames).toHaveProperty(preset.id);
      expect(de.equalizer.presetNames).toHaveProperty(preset.id);
    }
    expect(BUILT_IN_PRESETS.find((p) => p.id === "flat")?.gainsDb.every((g) => g === 0)).toBe(true);
  });

  it("applying a preset sets the curve, turns the EQ on and records the preset id", () => {
    applyPreset("bassBooster");
    const { dsp, eqPresetId } = useSettings.getState();
    expect(eqPresetId).toBe("bassBooster");
    expect(dsp.eq).toEqual({
      enabled: true,
      preampDb: 0,
      autoHeadroom: true,
      mode: { type: "graphic", bands: "ten", gainsDb: [6, 5.5, 4, 2, 0.5, 0, 0, 0, 0, 0] },
    });
    expect(dsp.bass.enabled).toBe(false);
  });

  it("only Deep Bass and Small speakers use the bass enhancer; others switch it off but keep its values", () => {
    useSettings
      .getState()
      .updateDsp((d) => ({ ...d, bass: { enabled: true, boostDb: 9, frequencyHz: 100, harmonics: 0.7 } }));
    applyPreset("rock");
    expect(useSettings.getState().dsp.bass).toEqual({
      enabled: false,
      boostDb: 9,
      frequencyHz: 100,
      harmonics: 0.7,
    });
    applyPreset("deepBass");
    expect(useSettings.getState().dsp.bass).toEqual({
      enabled: true,
      boostDb: 6,
      frequencyHz: 80,
      harmonics: 0.4,
    });
    expect(BUILT_IN_PRESETS.filter((p) => p.bass).map((p) => p.id)).toEqual(["deepBass", "smallSpeakers"]);
  });

  it("does not touch loudness compensation or the limiter", () => {
    useSettings.getState().updateDsp((d) => ({ ...d, loudnessCompensation: true, limiter: true }));
    applyPreset("pop");
    expect(useSettings.getState().dsp.loudnessCompensation).toBe(true);
    expect(useSettings.getState().dsp.limiter).toBe(true);
  });

  it("adapts to the 31-band layout", () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === "vShape")!;
    const dsp = builtInPresetDsp(preset, {
      ...DEFAULT_DSP,
      eq: { ...DEFAULT_DSP.eq, mode: { type: "graphic", bands: "thirtyOne", gainsDb: new Array(31).fill(0) } },
    });
    const mode = dsp.eq.mode;
    expect(mode.type === "graphic" && mode.gainsDb).toHaveLength(31);
    // The octave centers keep their exact values.
    GRAPHIC_FREQUENCIES.ten.forEach((f, i) => {
      const at = GRAPHIC_FREQUENCIES.thirtyOne.indexOf(f);
      expect(mode.type === "graphic" && mode.gainsDb[at]).toBe(preset.gainsDb[i]);
    });
  });

  it("uses octave bands when the parametric mode is active", () => {
    setEqMode("parametric");
    applyPreset("jazz");
    expect(useSettings.getState().dsp.eq.mode).toMatchObject({ type: "graphic", bands: "ten" });
  });
});

describe("custom presets", () => {
  it("stores the whole setup, re-applies it exactly and notices changes", () => {
    setEqMode("parametric");
    useSettings
      .getState()
      .updateDsp((d) => ({ ...d, bass: { ...d.bass, enabled: true }, loudnessCompensation: true }));
    saveCurrentAsPreset("Mine");
    const state = useSettings.getState();
    const [preset] = state.customPresets;
    expect(preset?.name).toBe("Mine");
    expect(state.eqPresetId).toBe(preset?.id);
    expect(preset?.dsp).toEqual(snapshotDsp(state.dsp));
    expect(isPresetModified(preset!, state.dsp)).toBe(false);

    applyPreset("flat");
    expect(useSettings.getState().dsp.eq.mode.type).toBe("graphic");
    applyPreset(preset!.id);
    expect(useSettings.getState().dsp).toMatchObject({
      eq: { enabled: true, mode: preset!.dsp.eq.mode },
      bass: { enabled: true },
      loudnessCompensation: true,
    });

    useSettings.getState().updateDsp((d) => ({ ...d, bass: { ...d.bass, boostDb: 1 } }));
    expect(isPresetModified(preset!, useSettings.getState().dsp)).toBe(true);
  });
});

describe("filtersFromGraphic", () => {
  it("returns neutral starter filters for a flat curve", () => {
    const filters = filtersFromGraphic("ten", new Array(10).fill(0));
    expect(filters).toHaveLength(5);
    expect(filters.every((f) => f.gainDb === 0)).toBe(true);
  });

  it("falls back to octave filters when the 31-band curve needs more than 16", () => {
    const gains = GRAPHIC_FREQUENCIES.thirtyOne.map((_, i) => (i % 2 ? 3 : -3));
    expect(filtersFromGraphic("thirtyOne", gains).length).toBeLessThanOrEqual(16);
  });
});

describe("preset JSON", () => {
  const dsp = () => snapshotDsp(useSettings.getState().dsp);

  it("round-trips through serialize and parse", () => {
    applyPreset("rock");
    const original = dsp();
    const [parsed] = parsePresets(serializePreset("Rock!", original));
    expect(parsed?.name).toBe("Rock!");
    expect(parsed?.dsp).toEqual(original);
  });

  it("round-trips a parametric setup", () => {
    setEqMode("parametric");
    const original = dsp();
    expect(parsePresets(serializePreset("P", original))[0]?.dsp).toEqual(original);
  });

  it("accepts a list and clamps wild values", () => {
    const base = JSON.parse(serializePreset("A", dsp()));
    base.dsp.eq.preampDb = 99;
    base.dsp.bass.boostDb = -5;
    base.dsp.eq.mode.gainsDb = [100];
    const parsed = parsePresets(JSON.stringify([base, { ...base, name: "B" }]));
    expect(parsed.map((p) => p.name)).toEqual(["A", "B"]);
    expect(parsed[0]?.dsp.eq.preampDb).toBe(20);
    expect(parsed[0]?.dsp.bass.boostDb).toBe(0);
    const mode = parsed[0]?.dsp.eq.mode;
    expect(mode?.type === "graphic" && mode.gainsDb).toHaveLength(10);
    expect(mode?.type === "graphic" && mode.gainsDb[0]).toBe(24);
  });

  it.each([
    ["not json", "{"],
    ["wrong format", JSON.stringify({ hello: "world" })],
    ["empty list", "[]"],
    ["missing dsp", JSON.stringify({ navify: "eq-preset", name: "x" })],
    [
      "unknown filter type",
      JSON.stringify({
        navify: "eq-preset",
        name: "x",
        dsp: {
          eq: { mode: { type: "parametric", filters: [{ enabled: true, kind: "wobble", freqHz: 1, q: 1 }] } },
          bass: { enabled: false, boostDb: 0, frequencyHz: 80, harmonics: 0 },
        },
      }),
    ],
  ])("rejects %s", (_name, text) => {
    expect(() => parsePresets(text)).toThrow(PresetParseError);
  });
});

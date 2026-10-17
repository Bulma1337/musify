import { ACCENT_PRESETS, accentPreset } from "./accentPresets";
import { contrastRatio, hueAndSaturation } from "./accent";

/** `--color-surface` and `--color-elevated` in index.css. */
const SURFACES = ["#111216", "#1c1d23"];

describe("accent presets", () => {
  it("have unique ids and fall back to purple", () => {
    const ids = ACCENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(accentPreset("dynamic").id).toBe("purple");
    expect(accentPreset(undefined).id).toBe("purple");
  });

  it("offer plenty of colors and gradients", () => {
    expect(ACCENT_PRESETS.filter((p) => p.kind === "solid").length).toBeGreaterThanOrEqual(16);
    expect(ACCENT_PRESETS.filter((p) => p.kind === "gradient").length).toBeGreaterThanOrEqual(10);
  });

  it.each(ACCENT_PRESETS.map((p) => [p.id, p] as const))("%s keeps text readable", (_id, preset) => {
    // Accent text and icons on the dark surfaces (WCAG 3:1 for UI components).
    for (const surface of SURFACES) {
      expect(contrastRatio(preset.shades[500], surface)).toBeGreaterThanOrEqual(3);
    }
    // Icons and labels on filled accent surfaces, at every point of a gradient's ends.
    const fills = preset.stops ?? [preset.shades[500]];
    for (const fill of fills) {
      expect(contrastRatio(preset.onAccent, fill)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(ACCENT_PRESETS.map((p) => [p.id, p] as const))("%s is not green (brand rules)", (_id, preset) => {
    for (const color of [...Object.values(preset.shades), ...(preset.stops ?? [])]) {
      const { hue, saturation } = hueAndSaturation(color);
      if (saturation > 0.25) expect(hue < 75 || hue > 165).toBe(true);
    }
  });
});

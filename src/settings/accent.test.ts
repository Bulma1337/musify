import { DEFAULT_ACCENT_SHADES, deriveAccent, relativeLuminance } from "./accent";

const hexToRgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

describe("deriveAccent", () => {
  it("keeps the hue of the cover color and returns lighter / darker shades around the base", () => {
    const blue = deriveAccent({ r: 40, g: 80, b: 180 });
    const [l4, l5, l6] = [blue[400], blue[500], blue[600]].map((h) => relativeLuminance(hexToRgb(h)));
    expect(l4!).toBeGreaterThan(l5!);
    expect(l5!).toBeGreaterThan(l6!);
    const base = hexToRgb(blue[500]);
    expect(base.b).toBeGreaterThan(base.r);
    expect(base.b).toBeGreaterThan(base.g);
  });

  it("keeps white text readable on the base shade, also for bright yellow and green covers", () => {
    for (const color of [
      { r: 250, g: 220, b: 40 },
      { r: 60, g: 220, b: 90 },
      { r: 30, g: 200, b: 220 },
      { r: 230, g: 40, b: 60 },
    ]) {
      expect(relativeLuminance(hexToRgb(deriveAccent(color)[500]))).toBeLessThanOrEqual(0.3);
    }
  });

  it("falls back to the default accent for grey covers", () => {
    expect(deriveAccent({ r: 120, g: 120, b: 120 })).toEqual(DEFAULT_ACCENT_SHADES);
    expect(deriveAccent({ r: 10, g: 10, b: 12 })).toEqual(DEFAULT_ACCENT_SHADES);
  });

  it("returns valid hex colors", () => {
    const shades = deriveAccent({ r: 83, g: 63, b: 140 });
    for (const hex of Object.values(shades)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

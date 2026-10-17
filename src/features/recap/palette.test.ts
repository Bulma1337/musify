import { contrastRatio, ensureContrast, hexToRgb, hslToHex } from "@/lib/contrast";
import {
  CURATED,
  CURATED_BASE_YEAR,
  MIN_ACCENT_CONTRAST,
  MIN_INK_CONTRAST,
  MIN_SOFT_CONTRAST,
  generatedPalette,
  paletteForYear,
  patternForYear,
  textSurfaces,
} from "./palette";
import { patternShapes } from "./patterns";

const YEARS = Array.from({ length: 101 }, (_, i) => 2000 + i);

const surfaces = textSurfaces;

const distance = (a: string, b: string) => {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
};

describe("recap palettes", () => {
  it.each(YEARS)("keeps text contrast (WCAG AA) in %i", (year) => {
    const p = paletteForYear(year);
    for (const bg of surfaces(p)) {
      expect(contrastRatio(p.ink, bg), `ink ${p.id}`).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
      expect(contrastRatio(p.inkSoft, bg), `soft ${p.id}`).toBeGreaterThanOrEqual(MIN_SOFT_CONTRAST);
      expect(contrastRatio(p.accent, bg), `accent ${p.id}`).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("is deterministic", () => {
    expect(paletteForYear(2031)).toEqual(paletteForYear(2031));
    expect(generatedPalette(2050)).toEqual(generatedPalette(2050));
  });

  it("gives every year of the curated cycle its own palette", () => {
    const ids = Array.from({ length: CURATED.length }, (_, i) => paletteForYear(CURATED_BASE_YEAR + i).id);
    expect(new Set(ids).size).toBe(CURATED.length);
  });

  it("uses the generated fallback outside the curated cycle", () => {
    expect(paletteForYear(2010).id).toBe("generated-2010");
    expect(paletteForYear(CURATED_BASE_YEAR + CURATED.length).id).toMatch(/^generated-/);
  });

  it("looks clearly different from one year to the next", () => {
    for (const year of YEARS.slice(0, -1)) {
      const a = paletteForYear(year);
      const b = paletteForYear(year + 1);
      const gradient = distance(a.bgFrom, b.bgFrom) + distance(a.bgTo, b.bgTo);
      // Generated years sometimes have to give up some color distance for readable text (a bright hue
      // flips to the light variant); their hues still sit 137 degrees apart.
      const generated = a.id.startsWith("generated-") || b.id.startsWith("generated-");
      expect(gradient, `${year} -> ${year + 1}`).toBeGreaterThan(generated ? 120 : 150);
      // The accent colors must differ too, not only the backgrounds.
      expect(distance(a.accent, b.accent), `accent ${year}`).toBeGreaterThan(40);
    }
  });

  it("alternates dark and light backgrounds across the curated cycle", () => {
    for (let i = 0; i < CURATED.length - 1; i++) {
      expect(paletteForYear(CURATED_BASE_YEAR + i).dark).not.toBe(
        paletteForYear(CURATED_BASE_YEAR + i + 1).dark,
      );
    }
  });
});

describe("patterns", () => {
  it("changes the pattern from year to year", () => {
    for (const year of YEARS.slice(0, -1)) {
      expect(patternForYear(year)).not.toBe(patternForYear(year + 1));
    }
  });

  it("draws different shapes for the same pattern in different years", () => {
    const a = patternShapes("blobs", 2024, 1.8);
    const b = patternShapes("blobs", 2025, 1.8);
    expect(a).not.toEqual(b);
    expect(patternShapes("blobs", 2024, 1.8)).toEqual(a);
  });

  it.each(["waves", "rings", "dots", "stripes", "grid", "blobs", "triangles"] as const)(
    "%s produces faint shapes only",
    (kind) => {
      const shapes = patternShapes(kind, 2026, 1.8);
      expect(shapes.length).toBeGreaterThan(5);
      expect(Math.max(...shapes.map((s) => s.opacity))).toBeLessThanOrEqual(0.2);
      expect(shapes.every((s) => /^M/.test(s.d))).toBe(true);
    },
  );
});

describe("contrast helpers", () => {
  it("computes known ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("ensureContrast pushes a color until it passes", () => {
    const fixed = ensureContrast("#888888", ["#ffffff"], 7);
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(7);
    expect(ensureContrast("#000000", ["#ffffff"], 7)).toBe("#000000");
  });

  it("converts hsl to hex", () => {
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(hslToHex(120, 1, 0.25)).toBe("#008000");
  });
});

import type { CSSProperties } from "react";
import { contrastRatio, ensureContrast, hexToRgb, hslToHex, mixHex } from "@/lib/contrast";

/**
 * Colors of one Recap year. These are deliberate art colors, independent of the app theme.
 * Text always keeps WCAG AA against both gradient stops (see palette.test.ts):
 * `ink` 7:1, `inkSoft` and `accent` 4.5:1.
 */
export interface RecapPalette {
  id: string;
  /** Light text on dark gradients, dark text on light ones. */
  dark: boolean;
  bgFrom: string;
  bgTo: string;
  /** Main text and big numbers. */
  ink: string;
  /** Secondary text. */
  inkSoft: string;
  /** Highlights: bars, ranks, the active progress segment. */
  accent: string;
  /** Translucent surface for cards, chosen to raise text contrast. */
  panel: string;
}

type Curated = Omit<RecapPalette, "panel">;

const withPanel = (p: Curated): RecapPalette => ({
  ...p,
  // Keep in sync with PANEL_DARK / PANEL_LIGHT (used for the contrast checks).
  panel: p.dark ? "rgb(0 0 0 / 0.28)" : "rgb(255 255 255 / 0.45)",
});

/**
 * Curated palettes. The order is chosen so that the pick for a year (stride 5 through the list) is
 * clearly different from the neighbouring years: dark and light, warm and cool alternate.
 */
export const CURATED: RecapPalette[] = [
  {
    id: "dusk",
    dark: true,
    bgFrom: "#1b1035",
    bgTo: "#3a1c71",
    ink: "#fdf6ff",
    inkSoft: "#d9c8f2",
    accent: "#ffb86b",
  },
  {
    id: "sand",
    dark: false,
    bgFrom: "#f6e8d0",
    bgTo: "#f2c9a0",
    ink: "#2b1708",
    inkSoft: "#5a3a1f",
    accent: "#9a3412",
  },
  {
    id: "deep",
    dark: true,
    bgFrom: "#04202c",
    bgTo: "#0b4f6c",
    ink: "#effcff",
    inkSoft: "#b6e3ef",
    accent: "#5eead4",
  },
  {
    id: "citrus",
    dark: false,
    bgFrom: "#ffe066",
    bgTo: "#ffb703",
    ink: "#231a00",
    inkSoft: "#4a3600",
    accent: "#7a1f00",
  },
  {
    id: "plum",
    dark: true,
    bgFrom: "#2b0a2e",
    bgTo: "#6a1b5a",
    ink: "#fff2fa",
    inkSoft: "#f1c7e3",
    accent: "#ff9ecb",
  },
  {
    id: "lagoon",
    dark: false,
    bgFrom: "#d8f3ee",
    bgTo: "#a9e2dc",
    ink: "#0a2c2a",
    inkSoft: "#1f5450",
    accent: "#085959",
  },
  {
    id: "ember",
    dark: true,
    bgFrom: "#2a0a0a",
    bgTo: "#7a1e1e",
    ink: "#fff4ec",
    inkSoft: "#f6cdb8",
    accent: "#ffd166",
  },
  {
    id: "lilac",
    dark: false,
    bgFrom: "#ece4ff",
    bgTo: "#cdbdf7",
    ink: "#1f1240",
    inkSoft: "#483a78",
    accent: "#5b21b6",
  },
  {
    id: "forest",
    dark: true,
    bgFrom: "#0d2418",
    bgTo: "#1f5d3b",
    ink: "#f6fff4",
    inkSoft: "#c4e8cf",
    accent: "#f4d35e",
  },
  {
    id: "coral",
    dark: false,
    bgFrom: "#ff8a7a",
    bgTo: "#ffb199",
    ink: "#2a0a05",
    inkSoft: "#5a1f12",
    accent: "#7a0f24",
  },
  {
    id: "aurora",
    dark: true,
    bgFrom: "#071a2f",
    bgTo: "#1b3a6b",
    ink: "#f2f7ff",
    inkSoft: "#bcd0f2",
    accent: "#7cf2c4",
  },
  {
    id: "paper",
    dark: false,
    bgFrom: "#f4f1ea",
    bgTo: "#e3dccf",
    ink: "#1c1c1c",
    inkSoft: "#4d473d",
    accent: "#b3261e",
  },
].map(withPanel);

/** First year of the curated cycle; each of the next 12 years gets its own palette. */
export const CURATED_BASE_YEAR = 2024;
const STRIDE = 5; // coprime with 12, so a cycle of 12 consecutive years never repeats a palette

export const MIN_INK_CONTRAST = 7;
export const MIN_SOFT_CONTRAST = 4.5;
export const MIN_ACCENT_CONTRAST = 4.5;

const PANEL_DARK = { color: "#000000", alpha: 0.28 };
const PANEL_LIGHT = { color: "#ffffff", alpha: 0.45 };

/**
 * Every background text can sit on: both gradient stops, their middle, and each of them under the
 * translucent card panel.
 */
export function textSurfaces(p: Pick<RecapPalette, "dark" | "bgFrom" | "bgTo">): string[] {
  const mid = mixHex(p.bgFrom, p.bgTo, 0.5);
  const panel = p.dark ? PANEL_DARK : PANEL_LIGHT;
  const stops = [p.bgFrom, p.bgTo, mid];
  return [...stops, ...stops.map((c) => mixHex(c, panel.color, panel.alpha))];
}

const passes = (fg: string, surfaces: string[], min: number) =>
  surfaces.every((bg) => contrastRatio(fg, bg) >= min);

/** One generated palette: `step` > 0 darkens (dark) or lightens (light) the background. */
function generatedVariant(year: number, hue: number, dark: boolean, step: number): RecapPalette {
  const bgFrom = dark
    ? hslToHex(hue, 0.55, Math.max(0.12 - 0.008 * step, 0.03))
    : hslToHex(hue, 0.7, Math.min(0.92 + 0.005 * step, 0.98));
  const bgTo = dark
    ? hslToHex(hue + 35, 0.6, Math.max(0.25 - 0.015 * step, 0.06))
    : hslToHex(hue + 30, 0.7, Math.min(0.8 + 0.012 * step, 0.95));
  const surfaces = textSurfaces({ dark, bgFrom, bgTo });
  return withPanel({
    id: `generated-${year}`,
    dark,
    bgFrom,
    bgTo,
    ink: ensureContrast(
      dark ? hslToHex(hue, 0.4, 0.96) : hslToHex(hue, 0.5, 0.1),
      surfaces,
      MIN_INK_CONTRAST,
    ),
    inkSoft: ensureContrast(
      dark ? hslToHex(hue, 0.3, 0.82) : hslToHex(hue, 0.35, 0.25),
      surfaces,
      MIN_SOFT_CONTRAST + 0.5,
    ),
    accent: ensureContrast(
      dark ? hslToHex(hue + 160, 0.9, 0.68) : hslToHex(hue + 200, 0.8, 0.28),
      surfaces,
      MIN_ACCENT_CONTRAST + 0.5,
    ),
  });
}

function readable(p: RecapPalette): boolean {
  const surfaces = textSurfaces(p);
  return (
    passes(p.ink, surfaces, MIN_INK_CONTRAST) &&
    passes(p.inkSoft, surfaces, MIN_SOFT_CONTRAST) &&
    passes(p.accent, surfaces, MIN_ACCENT_CONTRAST)
  );
}

/**
 * Fallback for years outside the curated cycle: hue from the golden angle (neighbouring years are
 * 137 degrees apart), light or dark by year. Text colors are nudged until they pass AA on every
 * surface. Bright hues (yellow-green) can't carry light text on a dark gradient: such a year flips to
 * the light variant first, and only if that fails too the background is darkened or lightened step by
 * step.
 */
export function generatedPalette(year: number, hueShift = 0): RecapPalette {
  const hue = (year * 137.508 + hueShift) % 360;
  const dark = year % 3 !== 0;
  const order = [
    [dark, 0],
    [!dark, 0],
    ...Array.from({ length: 12 }, (_, i) => [dark, i + 1] as const),
  ] as const;
  let last: RecapPalette | undefined;
  for (const [mode, step] of order) {
    last = generatedVariant(year, hue, mode, step);
    if (readable(last)) return last;
  }
  return last!;
}

function curatedFor(year: number): RecapPalette | undefined {
  const offset = year - CURATED_BASE_YEAR;
  return offset >= 0 && offset < CURATED.length ? CURATED[(offset * STRIDE) % CURATED.length] : undefined;
}

const rgbDistance = (a: string, b: string) => {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
};

/** Neighbouring years must not look alike (gradient stops and accent). */
function tooSimilar(a: RecapPalette, b: RecapPalette): boolean {
  const gradient = rgbDistance(a.bgFrom, b.bgFrom) + rgbDistance(a.bgTo, b.bgTo);
  return gradient <= 150 || rgbDistance(a.accent, b.accent) <= 40;
}

/** The palette of a year: deterministic, curated for 2024 to 2035, generated otherwise. */
export function paletteForYear(year: number): RecapPalette {
  const curated = curatedFor(year);
  if (curated) return curated;
  // The years right before and after the curated cycle are generated: turn their hue away from the
  // curated neighbour if they happen to look like it, without running into the other neighbour.
  const curatedNeighbour = curatedFor(year + 1) ?? curatedFor(year - 1);
  const generated = generatedPalette(year);
  if (!curatedNeighbour) return generated;
  const otherNeighbour = generatedPalette(curatedFor(year + 1) ? year - 1 : year + 1);
  const fits = (p: RecapPalette) => !tooSimilar(p, curatedNeighbour) && !tooSimilar(p, otherNeighbour);
  if (fits(generated)) return generated;
  for (const shift of [120, 240, 60, 180, 300, 30, 90, 150, 210, 270, 330]) {
    const candidate = generatedPalette(year, shift);
    if (fits(candidate)) return candidate;
  }
  return generated;
}

export const PATTERN_KINDS = ["waves", "rings", "dots", "stripes", "grid", "blobs", "triangles"] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

/** The background pattern of a year. Neighbouring years differ (step 3 through 7 kinds). */
export function patternForYear(year: number): PatternKind {
  return PATTERN_KINDS[
    (((year * 3 + 1) % PATTERN_KINDS.length) + PATTERN_KINDS.length) % PATTERN_KINDS.length
  ]!;
}

/** The palette as CSS variables, so slide components stay color-agnostic. */
export function paletteVars(p: RecapPalette): CSSProperties {
  return {
    "--r-ink": p.ink,
    "--r-soft": p.inkSoft,
    "--r-accent": p.accent,
    "--r-panel": p.panel,
    "--r-bg": p.bgFrom,
  } as CSSProperties;
}

export function paletteGradient(p: RecapPalette, angle = 160): string {
  return `linear-gradient(${angle}deg, ${p.bgFrom}, ${p.bgTo})`;
}

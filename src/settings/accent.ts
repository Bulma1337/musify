import type { Rgb } from "@/lib/color";

/** The default (purple) shades, used when a cover has no usable color. Same values as `--accent-*` in index.css. */
export const DEFAULT_ACCENT_SHADES = { 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed" } as const;

export type AccentShades = Record<400 | 500 | 600, string>;

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    const t = ((t0 % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
}

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** White text on the base accent needs at least 3:1 (large/bold UI text): luminance ≤ 0.3. */
const MAX_BASE_LUMINANCE = 0.3;

/**
 * Accent shades from a cover color: keeps the cover's hue, makes it vivid enough for UI accents and
 * dark enough for white button text. Grey covers fall back to the default accent.
 */
export function deriveAccent(color: Rgb): AccentShades {
  const [h, s] = rgbToHsl(color);
  if (s < 0.12) return { ...DEFAULT_ACCENT_SHADES };
  const sat = Math.min(0.85, Math.max(0.5, s));
  let lightness = 0.6;
  while (lightness > 0.32 && relativeLuminance(hslToRgb(h, sat, lightness)) > MAX_BASE_LUMINANCE) {
    lightness -= 0.02;
  }
  return {
    400: toHex(hslToRgb(h, sat, Math.min(lightness + 0.1, 0.8))),
    500: toHex(hslToRgb(h, sat, lightness)),
    600: toHex(hslToRgb(h, sat, Math.max(lightness - 0.1, 0.2))),
  };
}

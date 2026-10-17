import type { Rgb } from "@/lib/color";

/** Parses "#rrggbb". */
export function hexToRgb(hex: string): Rgb {
  const value = hex.replace(/^#/, "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two "#rrggbb" colors (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(hexToRgb(a)), relativeLuminance(hexToRgb(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Hue in degrees (0 … 360) and saturation (0 … 1, HSL) of a "#rrggbb" color. */
export function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const { r, g, b } = hexToRgb(hex);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0 };
  const d = max - min;
  const saturation = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { hue: h * 60, saturation };
}

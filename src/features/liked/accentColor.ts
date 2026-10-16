import type { Rgb } from "@/lib/color";

const FALLBACK: Rgb = { r: 139, g: 92, b: 246 };

/** Parses "#rgb" / "#rrggbb"; null for anything else. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** The current accent (`--accent-500`) as RGB, so the page header matches the accent color. */
export function readAccentColor(): Rgb {
  if (typeof document === "undefined") return FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent-500");
  return parseHex(value) ?? FALLBACK;
}

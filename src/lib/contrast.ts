/** Color helpers for the contrast checks (WCAG 2.x relative luminance and contrast ratio). */

export type Rgb255 = [number, number, number];

export function hexToRgb(hex: string): Rgb255 {
  const value = hex.replace(/^#/, "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb255;
}

export function rgbToHex([r, g, b]: Rgb255): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** h in degrees, s and l in 0..1. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    const t = (t0 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex([channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255]);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (none) to 21 (black on white). AA needs 4.5 for body text, 3 for large text. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Linear blend of two hex colors; `amount` 0 gives `a`, 1 gives `b`. */
export function mixHex(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount]);
}

/**
 * Moves `fg` towards black or white (whichever helps) until it reaches `min` contrast against every
 * background. Returns `fg` unchanged when it already passes.
 */
export function ensureContrast(fg: string, backgrounds: string[], min: number): string {
  const worst = (color: string) => Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));
  if (worst(fg) >= min) return fg;
  const towards =
    backgrounds.reduce((sum, bg) => sum + luminance(bg), 0) / backgrounds.length > 0.4
      ? "#000000"
      : "#ffffff";
  for (let step = 1; step <= 20; step++) {
    const candidate = mixHex(fg, towards, step / 20);
    if (worst(candidate) >= min) return candidate;
  }
  return towards;
}

/**
 * The accent colors to choose from: solid colors and fixed (never animated) gradients. The accent
 * stays the same everywhere; only album headers, the full-screen player and lyrics take their
 * colors from the cover. No green accents (see docs/BRAND.md).
 */

export interface AccentShades {
  /** Hover and light variants. */
  400: string;
  /** Text, icons and outlines on the dark surfaces. */
  500: string;
  /** Pressed state. */
  600: string;
}

export interface AccentPreset {
  id: string;
  kind: "solid" | "gradient";
  shades: AccentShades;
  /** Gradient presets: the two colors of filled accent surfaces (play buttons, sliders, switches). */
  stops?: readonly [string, string];
  /** Text and icon color on filled accent surfaces. */
  onAccent: string;
}

const LIGHT = "#ffffff";
const DARK = "#0b0b10";

const solid = (id: string, s400: string, s500: string, s600: string, onAccent = LIGHT): AccentPreset => ({
  id,
  kind: "solid",
  shades: { 400: s400, 500: s500, 600: s600 },
  onAccent,
});

const gradient = (
  id: string,
  from: string,
  to: string,
  text: readonly [string, string, string],
  onAccent: string,
): AccentPreset => ({
  id,
  kind: "gradient",
  shades: { 400: text[0], 500: text[1], 600: text[2] },
  stops: [from, to],
  onAccent,
});

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  // "Glut", the brand color of the logo (src-tauri/icons/musify-logo.svg).
  gradient("ember", "#ffa24c", "#ff3d7f", ["#ffa98a", "#ff7262", "#ff5470"], DARK),
  gradient("berry", "#ff5468", "#b5179e", ["#ff9db0", "#ff6b8b", "#f0457a"], DARK),
  gradient("neon", "#f07cff", "#6d4bff", ["#f5b0ff", "#e27cff", "#c95cff"], DARK),
  gradient("dusk", "#6a5cff", "#ff6fb5", ["#d0b8ff", "#b48cff", "#9a6bff"], DARK),
  gradient("midnight", "#4f7cff", "#a14fff", ["#a8bfff", "#7f9dff", "#6680ff"], LIGHT),
  gradient("ocean", "#3fd0ff", "#5b45f0", ["#9fe3ff", "#5fc4ff", "#4aa3ff"], DARK),
  gradient("ice", "#a1c4fd", "#c2e9fb", ["#d2ecff", "#a8d4ff", "#86bdf7"], DARK),
  gradient("gold", "#ffe259", "#ffa751", ["#ffe58a", "#ffc94d", "#ffb22e"], DARK),
  gradient("peach", "#ffcf8a", "#ff8fa3", ["#ffd2b0", "#ffb08f", "#ff9478"], DARK),
  gradient("slate", "#e0e3ea", "#8b93a7", ["#e6e8ef", "#c3c8d4", "#a1a8b8"], DARK),

  solid("red", "#ff7a8c", "#f43f5e", "#dc2a4b"),
  solid("coral", "#ffa197", "#ff7363", "#f2564a", DARK),
  solid("orange", "#ffb07a", "#ff8a3d", "#f27022", DARK),
  solid("amber", "#ffd27a", "#ffb224", "#f29b00", DARK),
  solid("yellow", "#ffe680", "#ffd60a", "#f0c400", DARK),
  solid("sand", "#f2dcc0", "#e3bf94", "#c9a06e", DARK),
  solid("blossom", "#ffd3de", "#ffadc2", "#ff8aa8", DARK),
  solid("pink", "#ff9cc6", "#ff5fa2", "#f03d88", DARK),
  solid("magenta", "#f2a6ff", "#e05cfa", "#c83fe6", DARK),
  solid("violet", "#caa8ff", "#a66bff", "#8f4ff5"),
  solid("indigo", "#a9b0ff", "#7d85ff", "#626af2"),
  solid("blue", "#82b6ff", "#3d8bff", "#2272ec"),
  solid("sky", "#94ddff", "#4cc3ff", "#20a9ee", DARK),
  solid("silver", "#f4f5f8", "#d6d9e2", "#b0b5c3", DARK),
];

export type AccentId = string;

export const DEFAULT_ACCENT: AccentId = "ember";

export function accentPreset(id: AccentId | undefined): AccentPreset {
  return ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS.find((p) => p.id === DEFAULT_ACCENT)!;
}

/** CSS background of filled accent surfaces: the gradient, or the solid 500 shade. */
export function accentFill(preset: AccentPreset): string {
  return preset.stops
    ? `linear-gradient(135deg, ${preset.stops[0]}, ${preset.stops[1]})`
    : preset.shades[500];
}

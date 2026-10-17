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
  solid("purple", "#a78bfa", "#8b5cf6", "#7c3aed"),
  solid("violet", "#c084fc", "#a855f7", "#9333ea"),
  solid("indigo", "#818cf8", "#6366f1", "#4f46e5"),
  solid("blue", "#60a5fa", "#3b82f6", "#2563eb"),
  solid("sky", "#7dd3fc", "#38bdf8", "#0ea5e9", DARK),
  solid("cyan", "#67e8f9", "#22d3ee", "#06b6d4", DARK),
  solid("teal", "#5eead4", "#2dd4bf", "#14b8a6", DARK),
  solid("yellow", "#fde047", "#facc15", "#eab308", DARK),
  solid("amber", "#fcd34d", "#fbbf24", "#f59e0b", DARK),
  solid("orange", "#fdba74", "#fb923c", "#f97316", DARK),
  solid("coral", "#fca5a5", "#f87171", "#ef4444", DARK),
  solid("red", "#fb7185", "#e11d48", "#be123c"),
  solid("pink", "#f9a8d4", "#f472b6", "#ec4899", DARK),
  solid("magenta", "#f0abfc", "#e879f9", "#d946ef", DARK),
  solid("copper", "#e0a07a", "#c97b4f", "#a85f37", DARK),
  solid("sand", "#eadbbf", "#d6b98c", "#b8975f", DARK),
  solid("slate", "#cbd5e1", "#94a3b8", "#64748b", DARK),
  solid("silver", "#f3f4f6", "#d1d5db", "#9ca3af", DARK),

  gradient("sunset", "#f97316", "#ec4899", ["#f9a8d4", "#f472b6", "#ec4899"], DARK),
  gradient("ocean", "#2563eb", "#06b6d4", ["#67e8f9", "#38bdf8", "#0ea5e9"], DARK),
  gradient("flame", "#dc2626", "#f59e0b", ["#fcd34d", "#fbbf24", "#f59e0b"], DARK),
  gradient("berry", "#c026d3", "#6366f1", ["#f0abfc", "#e879f9", "#d946ef"], LIGHT),
  gradient("peach", "#fb923c", "#f472b6", ["#fdba74", "#fb923c", "#f97316"], DARK),
  gradient("neon", "#ec4899", "#8b5cf6", ["#f9a8d4", "#f472b6", "#ec4899"], LIGHT),
  gradient("ember", "#e11d48", "#f97316", ["#fda4af", "#fb7185", "#f43f5e"], DARK),
  gradient("dusk", "#6366f1", "#ec4899", ["#c7d2fe", "#a5b4fc", "#818cf8"], LIGHT),
  gradient("gold", "#fde047", "#f97316", ["#fef08a", "#fde047", "#facc15"], DARK),
  gradient("ice", "#7dd3fc", "#a5b4fc", ["#bae6fd", "#7dd3fc", "#38bdf8"], DARK),
  gradient("blossom", "#fda4af", "#c4b5fd", ["#fbcfe8", "#f9a8d4", "#f472b6"], DARK),
  gradient("midnight", "#3b82f6", "#a855f7", ["#93c5fd", "#60a5fa", "#3b82f6"], LIGHT),
];

export type AccentId = string;

export const DEFAULT_ACCENT: AccentId = "purple";

export function accentPreset(id: AccentId | undefined): AccentPreset {
  return ACCENT_PRESETS.find((p) => p.id === id) ?? ACCENT_PRESETS[0]!;
}

/** CSS background of filled accent surfaces: the gradient, or the solid 500 shade. */
export function accentFill(preset: AccentPreset): string {
  return preset.stops
    ? `linear-gradient(135deg, ${preset.stops[0]}, ${preset.stops[1]})`
    : preset.shades[500];
}

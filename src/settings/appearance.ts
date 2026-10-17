import { useEffect } from "react";
import { accentFill, accentPreset } from "./accentPresets";
import { useLanguageController } from "./language";
import { useSettings } from "./store";

/**
 * Applies the look settings to the document: the accent (`--accent-*` shades, the fill of accent
 * surfaces and the color on them) and the stored language. Mount once in the app shell. The accent
 * never follows the cover; cover colors are used only by album headers, the full-screen player and
 * lyrics.
 */
export function useAppearance() {
  const accent = useSettings((s) => s.accent);
  useLanguageController();

  useEffect(() => {
    const preset = accentPreset(accent);
    const root = document.documentElement;
    root.dataset.accent = preset.id;
    root.style.setProperty("--accent-400", preset.shades[400]);
    root.style.setProperty("--accent-500", preset.shades[500]);
    root.style.setProperty("--accent-600", preset.shades[600]);
    root.style.setProperty("--accent-on", preset.onAccent);
    root.style.setProperty("--accent-fill", preset.stops ? accentFill(preset) : "none");
  }, [accent]);
}

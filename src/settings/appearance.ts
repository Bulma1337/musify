import { useEffect } from "react";
import { useCoverColor } from "@/components/media/useCoverColor";
import { usePlayer } from "@/player/store";
import { deriveAccent } from "./accent";
import { useLanguageController } from "./language";
import { useSettings } from "./store";

const SHADE_PROPERTIES = ["--accent-400", "--accent-500", "--accent-600"] as const;

/**
 * Applies the look settings to the document: the accent color (`data-accent`, "dynamic" derives the
 * shades from the playing track's cover) and the stored language. Mount once in the app shell.
 */
export function useAppearance() {
  const accent = useSettings((s) => s.accent);
  const cover = usePlayer((s) => s.current?.track.cover);
  // Only fetches a cover color while "dynamic" is selected.
  const coverColor = useCoverColor(accent === "dynamic" ? cover : undefined);
  useLanguageController();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    if (accent === "dynamic") {
      const shades = deriveAccent(coverColor);
      root.style.setProperty("--accent-400", shades[400]);
      root.style.setProperty("--accent-500", shades[500]);
      root.style.setProperty("--accent-600", shades[600]);
    } else {
      for (const property of SHADE_PROPERTIES) root.style.removeProperty(property);
    }
  }, [accent, coverColor]);
}

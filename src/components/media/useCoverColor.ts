import { useEffect, useState } from "react";
import type { CoverRef } from "@/api/provider";
import { useCoverSource } from "@/api/customCovers";
import { dominantColor, type Rgb } from "@/lib/color";
import { coverRequestSize } from "./coverSize";

export const FALLBACK_HEADER_COLOR: Rgb = { r: 83, g: 63, b: 140 };

/** Retries of a failed color extraction, and the pause before each. */
const RETRIES = 2;
const RETRY_MS = 3000;

/**
 * Color derived from a cover (cached per image), or `null` while it loads, without a cover, or if it
 * cannot be read. A failed read is retried a couple of times.
 */
export function useCoverColorOrNull(cover: CoverRef | undefined): Rgb | null {
  const src = useCoverSource(cover, coverRequestSize(64));
  const [color, setColor] = useState<{ src?: string; rgb: Rgb } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (left: number) => {
      void dominantColor(src).then((rgb) => {
        if (cancelled) return;
        if (rgb) setColor({ src, rgb });
        else if (left > 0) timer = setTimeout(() => attempt(left - 1), RETRY_MS);
      });
    };
    attempt(RETRIES);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [src]);
  return color && color.src === src ? color.rgb : null;
}

/** Header color derived from a cover (cached); purple-ish fallback while loading or without cover. */
export function useCoverColor(cover: CoverRef | undefined): Rgb {
  return useCoverColorOrNull(cover) ?? FALLBACK_HEADER_COLOR;
}

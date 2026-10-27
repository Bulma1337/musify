import { useEffect, useState } from "react";
import type { CoverRef } from "@/api/provider";
import { useCoverSource } from "@/api/customCovers";
import { dominantColor, type Rgb } from "@/lib/color";
import { coverRequestSize } from "./coverSize";

export const FALLBACK_HEADER_COLOR: Rgb = { r: 72, g: 74, b: 88 };

/** Header color derived from a cover (cached); a neutral slate while loading or without cover. */
export function useCoverColor(cover: CoverRef | undefined): Rgb {
  const src = useCoverSource(cover, coverRequestSize(64));
  const [color, setColor] = useState<{ cover?: CoverRef; rgb: Rgb }>({ rgb: FALLBACK_HEADER_COLOR });
  useEffect(() => {
    if (!cover || !src) return;
    let cancelled = false;
    void dominantColor(src).then((rgb) => {
      if (!cancelled && rgb) setColor({ cover, rgb });
    });
    return () => {
      cancelled = true;
    };
  }, [cover, src]);
  return color.cover === cover ? color.rgb : FALLBACK_HEADER_COLOR;
}

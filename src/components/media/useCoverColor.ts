import { useEffect, useState } from "react";
import type { CoverRef } from "@/api/provider";
import { useSession } from "@/api/session";
import { dominantColor, type Rgb } from "@/lib/color";
import { coverRequestSize } from "./coverSize";

export const FALLBACK_HEADER_COLOR: Rgb = { r: 83, g: 63, b: 140 };

/** Header color derived from a cover (cached); purple-ish fallback while loading or without cover. */
export function useCoverColor(cover: CoverRef | undefined): Rgb {
  const provider = useSession((s) => s.provider);
  const [color, setColor] = useState<{ cover?: CoverRef; rgb: Rgb }>({ rgb: FALLBACK_HEADER_COLOR });
  useEffect(() => {
    if (!cover || !provider) return;
    let cancelled = false;
    void dominantColor(provider.coverUrl(cover, coverRequestSize(64))).then((rgb) => {
      if (!cancelled && rgb) setColor({ cover, rgb });
    });
    return () => {
      cancelled = true;
    };
  }, [cover, provider]);
  return color.cover === cover ? color.rgb : FALLBACK_HEADER_COLOR;
}

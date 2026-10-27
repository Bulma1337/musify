import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CoverRef, Track } from "@/api/provider";
import { useCoverSource } from "@/api/customCovers";
import { useSession } from "@/api/session";
import { dominantColor, type Rgb } from "@/lib/color";
import { coverRequestSize } from "./coverSize";

export const FALLBACK_HEADER_COLOR: Rgb = { r: 72, g: 74, b: 88 };

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

/** Header color derived from a cover (cached); a neutral slate while loading or without cover. */
export function useCoverColor(cover: CoverRef | undefined): Rgb {
  return useCoverColorOrNull(cover) ?? FALLBACK_HEADER_COLOR;
}

/**
 * Color of the playing track for the player views (side panel, lyrics, full screen, mini player):
 * taken from its album's cover, the same image the album page uses, so both show the same color.
 * A server can store a separate picture per track (Navidrome: the art embedded in the file), and even
 * an identical-looking picture can tip the color choice elsewhere. Falls back to the track's cover.
 */
export function useTrackColorOrNull(track: Track | undefined): Rgb | null {
  const provider = useSession((s) => s.provider);
  const albumId = track?.album?.id;
  const album = useQuery({
    queryKey: [provider?.server.id, "album", albumId],
    queryFn: () => provider!.getAlbum(albumId!),
    enabled: !!provider && !!albumId,
  });
  const fromAlbum = !!provider && !!albumId && !album.isError;
  const cover = fromAlbum ? (album.data ? (album.data.cover ?? track?.cover) : undefined) : track?.cover;
  return useCoverColorOrNull(cover);
}

/** `useTrackColorOrNull` with the neutral fallback. */
export function useTrackColor(track: Track | undefined): Rgb {
  return useTrackColorOrNull(track) ?? FALLBACK_HEADER_COLOR;
}

import { useState } from "react";
import { Disc3, Heart, ListMusic, Mic2, Music } from "lucide-react";
import type { CoverRef } from "@/api/provider";
import { useSession } from "@/api/session";
import { cn } from "@/lib/cn";
import { coverRequestSize } from "./coverSize";

type Fallback = "track" | "album" | "playlist" | "artist" | "liked";

const FALLBACK_ICONS = { track: Music, album: Disc3, playlist: ListMusic, artist: Mic2, liked: Heart };

export interface CoverProps {
  cover?: CoverRef;
  /** Displayed edge length in px, used to pick the requested image size. */
  size: number;
  fallback?: Fallback;
  round?: boolean;
  className?: string;
  /** Eager-load covers that are visible immediately (page headers). */
  eager?: boolean;
}

/** Square (or round) cover art with a lazy image and an icon placeholder. */
export function Cover({ cover, size, fallback = "album", round, className, eager }: CoverProps) {
  const provider = useSession((s) => s.provider);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = cover && provider ? provider.coverUrl(cover, coverRequestSize(size)) : undefined;
  const Icon = FALLBACK_ICONS[fallback];

  return (
    <div
      className={cn(
        "relative aspect-square shrink-0 overflow-hidden bg-highlight shadow-[0_8px_24px_rgb(0_0_0/0.5)]",
        round ? "rounded-full" : "rounded-[4px]",
        fallback === "liked" && "bg-gradient-to-br from-accent-press via-accent to-accent-hover",
        className,
      )}
    >
      {src && failedSrc !== src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-subdued">
          <Icon
            className={cn(fallback === "liked" && "fill-white text-white")}
            style={{ width: "36%", height: "36%" }}
            strokeWidth={1.5}
          />
        </div>
      )}
    </div>
  );
}

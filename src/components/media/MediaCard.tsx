import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import type { CoverRef } from "@/api/provider";
import { cn } from "@/lib/cn";
import { Cover } from "./Cover";
import { PlayButton } from "./PlayButton";

export interface MediaCardProps {
  title: string;
  subtitle?: ReactNode;
  cover?: CoverRef;
  /** Route opened on click. */
  to: string;
  round?: boolean;
  fallback?: "album" | "playlist" | "artist" | "liked";
  playing?: boolean;
  onPlay?: () => void;
  /** Wraps the card, e.g. in a context-menu trigger. */
  className?: string;
}

/** Grid/shelf card with a hover play button (albums, playlists, artists, mixes). */
export function MediaCard({
  title,
  subtitle,
  cover,
  to,
  round,
  fallback,
  playing,
  onPlay,
  className,
}: MediaCardProps) {
  const navigate = useNavigate();

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(to);
      }}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-2 rounded-md p-3 transition-colors hover:bg-highlight focus-visible:bg-highlight",
        className,
      )}
    >
      <div className="relative">
        <Cover cover={cover} size={180} round={round} fallback={fallback} className="w-full" />
        {onPlay && (
          <PlayButton
            playing={!!playing}
            onClick={onPlay}
            size={48}
            className={cn(
              "absolute right-2 bottom-2 transition-[opacity,translate] duration-200",
              playing
                ? "translate-y-0 opacity-100"
                : "translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100",
            )}
          />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-bold" title={title}>
          {title}
        </p>
        {subtitle && <div className="line-clamp-2 text-sm text-subdued">{subtitle}</div>}
      </div>
    </div>
  );
}

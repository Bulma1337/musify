import { useNavigate } from "react-router";
import type { CoverRef } from "@/api/provider";
import { Cover } from "@/components/media/Cover";
import { PlayButton } from "@/components/media/PlayButton";
import { cn } from "@/lib/cn";

export interface QuickTileProps {
  title: string;
  cover?: CoverRef;
  fallback: "album" | "playlist";
  to: string;
  playing: boolean;
  onPlay: () => void;
}

/** Compact horizontal shortcut: cover on the left, bold title, play button on hover. */
export function QuickTile({ title, cover, fallback, to, playing, onPlay }: QuickTileProps) {
  const navigate = useNavigate();
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(to);
      }}
      className="group flex min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-md bg-elevated pr-3 transition-colors hover:bg-highlight focus-visible:bg-highlight"
    >
      <Cover cover={cover} size={64} fallback={fallback} className="size-16 rounded-none shadow-none" />
      <span className="min-w-0 flex-1 truncate font-bold" title={title}>
        {title}
      </span>
      <PlayButton
        playing={playing}
        onClick={onPlay}
        size={36}
        className={cn(
          "transition-opacity duration-200",
          playing ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      />
    </div>
  );
}

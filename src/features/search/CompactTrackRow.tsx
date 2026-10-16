import type { Track } from "@/api/provider";
import { Cover } from "@/components/media/Cover";
import { TrackMenu } from "@/components/media/TrackMenu";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { usePlayer } from "@/player/store";

/** Compact row for the short "Titel" list on the combined results view. Double-click plays. */
export function CompactTrackRow({ track, onPlay }: { track: Track; onPlay: () => void }) {
  const isCurrent = usePlayer((s) => s.current?.track.id === track.id);
  return (
    <TrackMenu tracks={[track]}>
      <div
        role="button"
        tabIndex={0}
        onDoubleClick={onPlay}
        onKeyDown={(e) => {
          if (e.key === "Enter") onPlay();
        }}
        className="flex h-14 items-center gap-3 rounded-[4px] px-2 text-sm outline-none select-none hover:bg-white/10 focus-visible:bg-white/10"
      >
        <Cover cover={track.cover} size={40} fallback="track" className="w-10 shadow-none" />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-base", isCurrent ? "text-accent" : "text-text")}>{track.title}</p>
          <p className="truncate text-subdued">{track.artistLine}</p>
        </div>
        <span className="tabular-nums text-subdued">{formatDuration(track.durationMs)}</span>
      </div>
    </TrackMenu>
  );
}

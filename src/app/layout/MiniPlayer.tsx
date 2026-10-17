import { useTranslation } from "react-i18next";
import { Maximize2, Minus, Pin, PinOff } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { useCoverColor } from "@/components/media/useCoverColor";
import { IconButton } from "@/components/ui/Button";
import { LyricsLines } from "@/features/lyrics/LyricsPage";
import { cn } from "@/lib/cn";
import { darkenCss } from "@/lib/color";
import { inTauri } from "@/lib/platform";
import { useElementSize } from "@/lib/useElementSize";
import { usePlayer } from "@/player/store";
import { LikeButton, ProgressRow, TransportButtons } from "./playerControls";
import { usePlayerView } from "./playerView";

/** Wider than this (and wider than tall) the miniplayer shows the lyrics next to the cover. */
const LYRICS_MIN_WIDTH = 520;
/** Lower than this it becomes a single row. */
const BAR_MAX_HEIGHT = 170;

function WindowButtons({ className }: { className?: string }) {
  const { t } = useTranslation();
  const onTop = usePlayerView((s) => s.miniOnTop);
  const setOnTop = usePlayerView((s) => s.setMiniOnTop);
  const backToShell = usePlayerView((s) => s.backToShell);
  const minimize = () => {
    if (!inTauri) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().minimize());
  };
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton
        label={onTop ? t("player.miniUnpin") : t("player.miniPin")}
        active={onTop}
        onClick={() => setOnTop(!onTop)}
      >
        {onTop ? <Pin size={16} /> : <PinOff size={16} />}
      </IconButton>
      <IconButton label={t("player.miniMinimize")} onClick={minimize}>
        <Minus size={16} />
      </IconButton>
      <IconButton label={t("player.miniBack")} onClick={backToShell}>
        <Maximize2 size={16} />
      </IconButton>
    </div>
  );
}

/**
 * Miniplayer: the main window shrunk to a small, optionally always-on-top player. Square or tall:
 * cover with controls on hover; wide: cover plus lyrics; very low: one row. Drag anywhere to move.
 */
export function MiniPlayer() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const rgb = useCoverColor(track?.cover);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const wide = size.width >= LYRICS_MIN_WIDTH && size.width > size.height * 1.3;
  const bar = size.height > 0 && size.height <= BAR_MAX_HEIGHT;
  const background = `linear-gradient(160deg, ${darkenCss(rgb, 0.6)} 0%, ${darkenCss(rgb, 0.2)} 100%)`;

  if (bar) {
    return (
      <div
        ref={ref}
        data-tauri-drag-region
        className="flex h-full w-full items-center gap-3 overflow-hidden px-3 text-text"
        style={{ backgroundImage: background }}
      >
        {track && (
          <Cover
            cover={track.cover}
            size={160}
            fallback="track"
            className="h-[70%] w-auto shrink-0 shadow-none"
          />
        )}
        <div data-tauri-drag-region className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{track?.title ?? t("player.nothingPlaying")}</p>
          <p className="truncate text-xs text-text/70">{track?.artistLine}</p>
          <ProgressRow hideTimes className="mt-1" />
        </div>
        <TransportButtons size={16} compact />
        <WindowButtons />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="group relative flex h-full w-full overflow-hidden text-text"
      style={{ backgroundImage: background }}
    >
      {track ? (
        <>
          <div
            data-tauri-drag-region
            className={cn("relative shrink-0", wide ? "h-full aspect-square" : "absolute inset-0")}
          >
            <Cover
              cover={track.cover}
              size={600}
              fallback="track"
              className="pointer-events-none h-full w-full rounded-none object-cover shadow-none"
            />
          </div>
          {wide && (
            <div className="relative min-w-0 flex-1">
              <LyricsLines track={track} />
            </div>
          )}
          {/* Controls: always shown while hovering, title on a gradient at the bottom. */}
          <div
            data-tauri-drag-region
            className={cn(
              "absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-4 pt-12 pb-3",
              wide && "right-auto w-[min(100%,var(--mini-cover))]",
            )}
            style={wide ? ({ "--mini-cover": `${size.height}px` } as React.CSSProperties) : undefined}
          >
            <div data-tauri-drag-region className="flex min-w-0 items-end gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{track.title}</p>
                <p className="truncate text-sm text-text/75">{track.artistLine}</p>
              </div>
              <LikeButton track={track} />
            </div>
            <div className="flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <ProgressRow hideTimes />
              <TransportButtons size={18} compact className="justify-center" />
            </div>
          </div>
        </>
      ) : (
        <div data-tauri-drag-region className="grid flex-1 place-items-center text-sm text-text/70">
          {t("player.nothingPlaying")}
        </div>
      )}
      <WindowButtons className="absolute top-2 right-2 rounded-full bg-black/40 px-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" />
    </div>
  );
}

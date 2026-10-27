import { useTranslation } from "react-i18next";
import { Maximize2, Minus, Pin, PinOff } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { useTrackColor } from "@/components/media/useCoverColor";
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
 * the whole cover with title and controls below; wide: cover plus lyrics; very low: one row. Drag
 * anywhere to move.
 */
export function MiniPlayer() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const rgb = useTrackColor(track);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [coverRef, cover] = useElementSize<HTMLDivElement>();
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

  if (wide && track) {
    return (
      <div
        ref={ref}
        data-tauri-drag-region
        className="relative flex h-full w-full overflow-hidden text-text"
        style={{ backgroundImage: background }}
      >
        <div
          data-tauri-drag-region
          className="flex h-full shrink-0 flex-col gap-2 p-3"
          style={{ width: size.height }}
        >
          <div data-tauri-drag-region className="relative min-h-0 flex-1">
            <Cover
              cover={track.cover}
              size={600}
              fallback="track"
              className="pointer-events-none absolute inset-0 m-auto aspect-square max-h-full max-w-full rounded-md"
            />
          </div>
          <TrackLine />
          <ProgressRow hideTimes />
          <TransportButtons size={18} compact className="justify-center" />
        </div>
        <div className="relative min-w-0 flex-1">
          <LyricsLines track={track} />
        </div>
        <WindowButtons className="absolute top-2 right-2 rounded-full bg-black/55 px-1 backdrop-blur-sm" />
      </div>
    );
  }

  // Square or tall: a bar with the window buttons, the whole cover, then title and controls.
  // clientWidth includes the 2 × 16 px side padding.
  const side = Math.max(0, Math.min(cover.width - 32, cover.height));
  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="flex h-full w-full flex-col overflow-hidden text-text"
      style={{ backgroundImage: background }}
    >
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center justify-end px-2">
        <WindowButtons className="rounded-full bg-black/45 px-1" />
      </div>
      <div ref={coverRef} data-tauri-drag-region className="grid min-h-0 flex-1 place-items-center px-4">
        {track ? (
          side > 0 && (
            <div style={{ width: side, height: side }}>
              <Cover
                cover={track.cover}
                size={600}
                fallback="track"
                className="pointer-events-none h-full w-full rounded-md"
              />
            </div>
          )
        ) : (
          <p className="text-sm text-text/70">{t("player.nothingPlaying")}</p>
        )}
      </div>
      {track && (
        <div data-tauri-drag-region className="flex shrink-0 flex-col gap-1.5 px-4 pt-3 pb-3">
          <TrackLine />
          <ProgressRow hideTimes />
          <TransportButtons size={18} compact className="justify-center" />
        </div>
      )}
    </div>
  );
}

/** Title, artists and the heart of the playing track. */
function TrackLine() {
  const track = usePlayer((s) => s.current?.track);
  if (!track) return null;
  return (
    <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{track.title}</p>
        <p className="truncate text-sm text-text/75">{track.artistLine}</p>
      </div>
      <LikeButton track={track} />
    </div>
  );
}

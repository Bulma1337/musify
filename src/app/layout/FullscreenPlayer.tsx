import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MicVocal, Minimize2 } from "lucide-react";
import { Cover } from "@/components/media/Cover";
import { useCoverColor } from "@/components/media/useCoverColor";
import { IconButton } from "@/components/ui/Button";
import { LyricsLines } from "@/features/lyrics/LyricsPage";
import { cn } from "@/lib/cn";
import { darkenCss } from "@/lib/color";
import { usePlayer } from "@/player/store";
import { LikeButton, ProgressRow, TransportButtons, VolumeControl } from "./playerControls";
import { usePlayerView } from "./playerView";

/** Controls hide after this long without mouse movement while music plays. */
const IDLE_MS = 3000;

/**
 * Full-screen player: big cover on the cover's color, title, controls; optionally the synced lyrics
 * next to it. Esc or the button leaves full screen.
 */
export function FullscreenPlayer() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const contextName = usePlayer((s) => s.context?.name);
  const backToShell = usePlayerView((s) => s.backToShell);
  const rgb = useCoverColor(track?.cover);
  const [lyrics, setLyrics] = useState(false);
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") backToShell();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backToShell]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const wake = () => {
    setIdle(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  };
  const hidden = idle && isPlaying;

  return (
    <div
      role="dialog"
      aria-label={t("player.fullscreen")}
      onMouseMove={wake}
      onPointerDown={wake}
      className={cn("fixed inset-0 z-50 flex flex-col overflow-hidden text-text", hidden && "cursor-none")}
      style={{
        backgroundImage: `linear-gradient(160deg, ${darkenCss(rgb, 0.7)} 0%, ${darkenCss(rgb, 0.25)} 70%, rgb(0 0 0) 100%)`,
      }}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 px-8 pt-6 transition-opacity duration-500",
          hidden && "opacity-0",
        )}
      >
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-text/80">
          {contextName ? t("player.playingFrom", { name: contextName }) : ""}
        </p>
        <IconButton label={t("player.lyrics")} active={lyrics} onClick={() => setLyrics((v) => !v)}>
          <MicVocal size={20} />
        </IconButton>
        <IconButton label={t("player.fullscreenExit")} onClick={backToShell}>
          <Minimize2 size={20} />
        </IconButton>
      </header>

      {track ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 gap-10 px-8 py-6",
            lyrics ? "flex-row items-stretch" : "flex-col items-center justify-center",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-6",
              lyrics ? "w-[min(40vw,560px)] shrink-0 justify-end" : "items-center",
            )}
          >
            <Cover
              cover={track.cover}
              size={1000}
              fallback="track"
              className={cn(
                "shadow-[0_24px_60px_rgb(0_0_0/0.5)]",
                lyrics ? "w-full max-w-[min(40vw,56vh)]" : "w-[min(56vh,46vw)]",
              )}
            />
            <div className={cn("flex w-full min-w-0 items-end gap-4", !lyrics && "max-w-[min(56vh,46vw)]")}>
              <div className="min-w-0 flex-1">
                <h2 className="text-4xl leading-tight font-extrabold tracking-tight wrap-anywhere">
                  {track.title}
                </h2>
                <p className="mt-1 text-lg text-text/75 wrap-anywhere">{track.artistLine}</p>
              </div>
              <LikeButton track={track} size={24} />
            </div>
          </div>
          {lyrics && (
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-black/15">
              <LyricsLines track={track} />
            </div>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center text-text/70">
          {t("player.nothingPlaying")}
        </div>
      )}

      <footer
        className={cn(
          "flex shrink-0 flex-col items-center gap-3 px-8 pb-8 transition-opacity duration-500",
          hidden && "opacity-0",
        )}
      >
        <ProgressRow className="max-w-4xl text-text/80" />
        <div className="relative flex w-full max-w-4xl items-center justify-center">
          <TransportButtons size={24} />
          <div className="absolute right-0">
            <VolumeControl sliderClassName="w-28" />
          </div>
        </div>
      </footer>
    </div>
  );
}

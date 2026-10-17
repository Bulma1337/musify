import { useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { Lyrics } from "@/api/provider";
import { useCoverColor } from "@/components/media/useCoverColor";
import { cn } from "@/lib/cn";
import type { Rgb } from "@/lib/color";
import { usePlayer } from "@/player/store";
import { LYRICS_PATH, useLyricsRoute } from "./useLyricsRoute";
import { activeLineIndex, useLyricsOffset } from "./timing";
import { useLyrics } from "./useLyrics";
import { useLyricsClock } from "./useLyricsClock";

const darken = (rgb: Rgb, factor: number) =>
  `rgb(${Math.round(rgb.r * factor)} ${Math.round(rgb.g * factor)} ${Math.round(rgb.b * factor)})`;

/**
 * A window of fixed height over all lines. The active line glides to the top (like the full view);
 * near the end the window stops so it stays filled instead of shrinking to the last line.
 */
function PreviewBody({ lyrics, trackId }: { lyrics: Lyrics; trackId: string }) {
  const clockMs = useLyricsClock({ intervalMs: 100 });
  const { offsetMs } = useLyricsOffset(trackId);
  const lines = useMemo(() => lyrics.lines.filter((line) => line.text.trim() !== ""), [lyrics]);
  const active = lyrics.synced ? activeLineIndex(lines, clockMs - lyrics.offsetMs - offsetMs) : -1;
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);

  useLayoutEffect(() => {
    const box = viewport.current;
    const list = content.current;
    if (!box || !list) return;
    const line = lineRefs.current[Math.max(active, 0)];
    const maxShift = Math.max(0, list.scrollHeight - box.clientHeight);
    const shift = Math.min(line?.offsetTop ?? 0, maxShift);
    list.style.transform = `translateY(${-shift}px)`;
  }, [active, lines]);

  return (
    <div ref={viewport} className="relative h-[7.5rem] overflow-hidden">
      <div
        ref={content}
        className="flex flex-col gap-1 text-lg leading-snug font-bold transition-transform duration-500 ease-out will-change-transform"
      >
        {lines.map((line, i) => (
          <p
            key={`${i}-${line.text}`}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className={cn(
              "wrap-anywhere transition-colors duration-300",
              i === active || !lyrics.synced ? "text-text" : "text-text/55",
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Right-panel teaser: a few lyric lines on the cover's color; opens the full view. Hidden without lyrics. */
export function LyricsPreviewCard() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const { lyrics } = useLyrics(track);
  const rgb = useCoverColor(track?.cover);
  // The full lyrics view is open: no need to show the same text twice.
  const fullViewOpen = useLyricsRoute().open;
  if (!track || !lyrics || fullViewOpen) return null;

  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{
        backgroundImage: `linear-gradient(160deg, ${darken(rgb, 0.8)} 0%, ${darken(rgb, 0.45)} 100%)`,
      }}
    >
      <Link
        to={LYRICS_PATH}
        aria-label={t("lyrics.openFull")}
        className="flex flex-col gap-3 p-4 hover:bg-white/5"
      >
        <h3 className="font-bold">{t("lyrics.previewTitle")}</h3>
        <PreviewBody lyrics={lyrics} trackId={track.id} />
      </Link>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Minus, MicVocal, Plus, RotateCcw, X } from "lucide-react";
import type { LyricLine, Lyrics, Track } from "@/api/provider";
import { useCoverColor } from "@/components/media/useCoverColor";
import { IconButton } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { Rgb } from "@/lib/color";
import { usePlayer } from "@/player/store";
import { LyricLineView, type LineState } from "./LyricLineView";
import { activeLineIndex, displayStartMs, useLyricsOffset } from "./timing";
import { useLyrics } from "./useLyrics";
import { useLyricsClock } from "./useLyricsClock";
import { useLyricsRoute } from "./useLyricsRoute";

/** How long manual scrolling keeps the view from jumping back to the active line. */
const AUTO_SCROLL_PAUSE_MS = 5_000;
/** Where the active line sits in the viewport, measured from the top. */
const FOCUS_POSITION = 1 / 3;

/** Lines keep wrapping inside the column; the font follows the column width, not the window. */
const LINE_FONT_SIZE = "clamp(1.375rem, 0.9rem + 3.2cqw, 2.75rem)";
const PLAIN_FONT_SIZE = "clamp(1.125rem, 0.85rem + 1.8cqw, 1.75rem)";

/** Soft top and bottom edge while scrolling; the column itself keeps its full width. */
const FADE_MASK: CSSProperties = {
  maskImage: "linear-gradient(to bottom, transparent 0, black 1rem, black calc(100% - 1.5rem), transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to bottom, transparent 0, black 1rem, black calc(100% - 1.5rem), transparent 100%)",
};

const darken = (rgb: Rgb, factor: number) =>
  `rgb(${Math.round(rgb.r * factor)} ${Math.round(rgb.g * factor)} ${Math.round(rgb.b * factor)})`;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Space kept free above and below a line that is brought into view. */
const EDGE_MARGIN_PX = 24;

/**
 * Scrolls so that `element` sits at `FOCUS_POSITION` of the scroller (layout pixels, zoom safe). A line
 * taller than the space below the focus position is moved up until all of it is visible (as far as the
 * viewport allows), so long wrapped lines are never cut off at the bottom.
 */
function scrollToFocus(scroller: HTMLElement, element: HTMLElement, smooth: boolean) {
  let top = 0;
  for (
    let node: HTMLElement | null = element;
    node && node !== scroller;
    node = node.offsetParent as HTMLElement | null
  ) {
    top += node.offsetTop;
  }
  const viewport = scroller.clientHeight;
  let target = top - viewport * FOCUS_POSITION;
  const overflow = top + element.offsetHeight - target - (viewport - EDGE_MARGIN_PX);
  if (overflow > 0) target += overflow;
  target = Math.min(target, top - EDGE_MARGIN_PX);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({
      top: Math.max(0, target),
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }
}

function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        {icon}
        <p className="text-xl font-bold wrap-anywhere">{title}</p>
        {hint && <p className="text-sm text-text/70 wrap-anywhere">{hint}</p>}
      </div>
    </div>
  );
}

/** Offset control in the top bar: −, current value, +, reset. */
function OffsetControl({ trackId }: { trackId: string }) {
  const { t, i18n } = useTranslation();
  const { offsetMs, nudge, reset } = useLyricsOffset(trackId);
  const value = (offsetMs / 1000).toLocaleString(i18n.language, {
    signDisplay: "exceptZero",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
    <div role="group" aria-label={t("lyrics.offsetLabel")} className="flex items-center gap-1">
      <IconButton label={t("lyrics.earlier")} onClick={() => nudge(-1)}>
        <Minus size={16} />
      </IconButton>
      <span className="min-w-12 text-center text-xs font-semibold tabular-nums" aria-live="polite">
        {t("lyrics.offsetValue", { value })}
      </span>
      <IconButton label={t("lyrics.later")} onClick={() => nudge(1)}>
        <Plus size={16} />
      </IconButton>
      <IconButton label={t("lyrics.resetOffset")} onClick={reset} disabled={offsetMs === 0}>
        <RotateCcw size={15} />
      </IconButton>
    </div>
  );
}

/** Synced lyrics: highlighting, click to seek, auto-scroll with a 5 s pause after manual scrolling. */
function SyncedLines({
  lyrics,
  trackId,
  scrollerRef,
  paused,
}: {
  lyrics: Lyrics;
  trackId: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  paused: boolean;
}) {
  const { offsetMs: userOffsetMs } = useLyricsOffset(trackId);
  const hasWords = useMemo(() => lyrics.lines.some((l) => l.words && l.words.length > 0), [lyrics]);
  const clockMs = useLyricsClock({ intervalMs: hasWords ? 0 : 50 });
  const totalOffsetMs = lyrics.offsetMs + userOffsetMs;
  const active = activeLineIndex(lyrics.lines, clockMs - totalOffsetMs);

  const elements = useRef(new Map<number, HTMLLIElement>());
  const register = useCallback((index: number, element: HTMLLIElement | null) => {
    if (element) elements.current.set(index, element);
    else elements.current.delete(index);
  }, []);

  const firstScroll = useRef(true);
  useEffect(() => {
    const scroller = scrollerRef.current;
    const element = elements.current.get(Math.max(active, 0));
    if (!scroller || !element || paused) return;
    scrollToFocus(scroller, element, !firstScroll.current);
    firstScroll.current = false;
  }, [active, paused, scrollerRef]);

  const onSeek = useCallback(
    (index: number) => {
      const line = lyrics.lines[index];
      if (line?.startMs === undefined) return;
      usePlayer.getState().seek(displayStartMs(lyrics, line.startMs, userOffsetMs));
    },
    [lyrics, userOffsetMs],
  );

  return (
    <ul className="m-0 list-none p-0" style={{ fontSize: LINE_FONT_SIZE, lineHeight: 1.25 }}>
      {lyrics.lines.map((line: LyricLine, index) => {
        const state: LineState = index < active ? "past" : index === active ? "active" : "upcoming";
        return (
          <LyricLineView
            key={index}
            index={index}
            line={line}
            state={state}
            offsetMs={totalOffsetMs}
            clockMs={state === "active" && hasWords ? clockMs : undefined}
            nextStartMs={lyrics.lines[index + 1]?.startMs}
            register={register}
            onSeek={onSeek}
          />
        );
      })}
    </ul>
  );
}

function PlainLines({ lyrics }: { lyrics: Lyrics }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="mb-6 rounded-lg bg-black/20 px-4 py-3 text-sm text-text/80 wrap-anywhere">
        {t("lyrics.unsyncedHint")}
      </p>
      <div
        className="font-semibold text-text/90"
        style={{ fontSize: PLAIN_FONT_SIZE, lineHeight: 1.4 }}
        data-testid="plain-lyrics"
      >
        {lyrics.lines.map((line, index) => (
          <p key={index} className="min-h-[1.4em] wrap-anywhere">
            {line.text}
          </p>
        ))}
      </div>
    </>
  );
}

function LyricsContent({ track }: { track: Track }) {
  const { t } = useTranslation();
  const { lyrics, source, instrumental, isLoading } = useLyrics(track);
  const rgb = useCoverColor(track.cover);
  const { close } = useLyricsRoute();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pauseAutoScroll = useCallback(() => {
    setPaused(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPaused(false), AUTO_SCROLL_PAUSE_MS);
  }, []);
  const resumeAutoScroll = useCallback(() => {
    window.clearTimeout(timer.current);
    setPaused(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const synced = lyrics?.synced === true;
  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="grid h-full place-items-center text-text/70" aria-live="polite">
        <div className="flex flex-col items-center gap-3">
          <Spinner size={28} />
          <span className="text-sm">{t("lyrics.loading")}</span>
        </div>
      </div>
    );
  } else if (!lyrics) {
    body = (
      <EmptyState
        icon={<MicVocal size={40} className="text-text/60" />}
        title={instrumental ? t("lyrics.instrumental") : t("lyrics.none")}
        hint={instrumental ? undefined : t("lyrics.noneHint")}
      />
    );
  } else {
    body = (
      <div
        ref={scrollerRef}
        tabIndex={-1}
        onWheel={pauseAutoScroll}
        onTouchMove={pauseAutoScroll}
        onPointerDown={(event) => {
          // Only the scrollbar itself (not a line) counts as manual scrolling.
          if (event.target === event.currentTarget) pauseAutoScroll();
        }}
        onKeyDown={(event) => {
          if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(event.key)) {
            pauseAutoScroll();
          }
        }}
        data-testid="lyrics-scroller"
        className="@container absolute inset-0 overflow-x-hidden overflow-y-auto"
        style={FADE_MASK}
      >
        <div className="relative mx-auto box-border w-full max-w-[52rem] px-8 pt-6 pb-[70vh]">
          {synced ? (
            <SyncedLines
              lyrics={lyrics}
              trackId={track.id}
              scrollerRef={scrollerRef}
              paused={paused}
            />
          ) : (
            <PlainLines lyrics={lyrics} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden"
      style={{ backgroundImage: `linear-gradient(180deg, ${darken(rgb, 0.62)} 0%, ${darken(rgb, 0.36)} 100%)` }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-48 flex-1">
          <h1 className="text-base font-bold wrap-anywhere">{track.title}</h1>
          <p className="text-sm text-text/70 wrap-anywhere">{track.artistLine}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {synced && <OffsetControl trackId={track.id} />}
          <IconButton label={t("lyrics.close")} onClick={close}>
            <X size={20} />
          </IconButton>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {body}
        {synced && paused && (
          <button
            type="button"
            onClick={resumeAutoScroll}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-text px-4 py-2 text-sm font-bold text-black shadow-lg hover:scale-105"
          >
            {t("lyrics.backToCurrent")}
          </button>
        )}
      </div>
      {lyrics && source && (
        <p className="shrink-0 px-8 py-2 text-center text-xs text-text/60 wrap-anywhere">
          {t("lyrics.credit", { source: t(`lyrics.sources.${source}`) })}
        </p>
      )}
    </div>
  );
}

/** Full-screen lyrics for the playing track, on the cover's color. */
export function LyricsPage() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track);
  const { close } = useLyricsRoute();

  if (!track) {
    return (
      <div className="absolute inset-0 flex flex-col bg-surface">
        <header className="flex shrink-0 justify-end px-4 py-3">
          <IconButton label={t("lyrics.close")} onClick={close}>
            <X size={20} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={<MicVocal size={40} className="text-text/60" />}
            title={t("lyrics.nothingPlaying")}
          />
        </div>
      </div>
    );
  }
  return <LyricsContent key={track.id} track={track} />;
}

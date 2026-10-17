import { memo } from "react";
import type { CSSProperties } from "react";
import type { LyricLine } from "@/api/provider";
import { cn } from "@/lib/cn";

export type LineState = "past" | "active" | "upcoming";

interface LyricLineViewProps {
  index: number;
  line: LyricLine;
  state: LineState;
  /** Lyrics offset + user offset in ms: a lyric time `t` is shown at `t + offsetMs`. */
  offsetMs: number;
  /** Playback position in ms; only passed to the active line, and only when it has word timing. */
  clockMs: number | undefined;
  /** Start of the following line (lyric time), used as the end of the last word. */
  nextStartMs: number | undefined;
  register: (index: number, element: HTMLLIElement | null) => void;
  onSeek: (index: number) => void;
}

const LIT = "var(--color-text)";
const DIM = "color-mix(in oklab, var(--color-text) 55%, transparent)";

/** Fill ratio (0..1) of one word at lyric time `timeMs`. */
function wordProgress(timeMs: number, startMs: number, endMs: number): number {
  if (timeMs <= startMs) return 0;
  if (timeMs >= endMs) return 1;
  return (timeMs - startMs) / (endMs - startMs);
}

function KaraokeWords({
  line,
  clockMs,
  offsetMs,
  nextStartMs,
}: {
  line: LyricLine;
  clockMs: number;
  offsetMs: number;
  nextStartMs: number | undefined;
}) {
  const words = line.words ?? [];
  const time = clockMs - offsetMs;
  return (
    <>
      {words.map((word, i) => {
        const end = word.endMs ?? words[i + 1]?.startMs ?? nextStartMs ?? word.startMs + 600;
        const fill = wordProgress(time, word.startMs, Math.max(end, word.startMs + 1));
        const style: CSSProperties = {
          backgroundImage: `linear-gradient(90deg, ${LIT} ${fill * 100}%, ${DIM} ${fill * 100}%)`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          WebkitTextFillColor: "transparent",
        };
        return (
          <span key={`${word.startMs}-${i}`} style={style}>
            {word.text}
          </span>
        );
      })}
    </>
  );
}

/** One synced lyric line. Memoized: only the lines whose state changes re-render. */
export const LyricLineView = memo(function LyricLineView({
  index,
  line,
  state,
  offsetMs,
  clockMs,
  nextStartMs,
  register,
  onSeek,
}: LyricLineViewProps) {
  const spacer = line.text.trim() === "";
  const tone =
    state === "active" ? "text-text" : state === "past" ? "text-text/35" : "text-text/60 hover:text-text/80";

  return (
    <li ref={(element) => register(index, element)} className="py-[0.3em]">
      {spacer ? (
        <div aria-hidden className={cn("min-h-[1.2em] transition-colors duration-300", tone)}>
          {state === "active" ? "♪" : ""}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSeek(index)}
          aria-current={state === "active" ? "true" : undefined}
          className={cn(
            "block w-full text-left font-bold transition-colors duration-300 wrap-anywhere",
            tone,
            state !== "active" && "cursor-pointer",
          )}
        >
          {state === "active" && clockMs !== undefined && line.words ? (
            <KaraokeWords line={line} clockMs={clockMs} offsetMs={offsetMs} nextStartMs={nextStartMs} />
          ) : (
            line.text
          )}
        </button>
      )}
    </li>
  );
});

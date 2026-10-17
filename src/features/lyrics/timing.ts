import { useCallback, useSyncExternalStore } from "react";
import type { LyricLine, Lyrics } from "@/api/provider";

/**
 * Index of the line that is active at `timeMs`: the last line whose `startMs` is <= `timeMs`.
 * Returns -1 before the first line (or when no line has a time). Lines must be sorted by `startMs`.
 * Offsets are the caller's business: pass `positionMs - totalOffsetMs`.
 */
export function activeLineIndex(lines: readonly LyricLine[], timeMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lines[mid]!.startMs;
    if (start !== undefined && start <= timeMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Time at which a line is shown, including the lyrics' own offset and the user's per-track offset. */
export function displayStartMs(lyrics: Lyrics, startMs: number, userOffsetMs: number): number {
  return Math.max(0, startMs + lyrics.offsetMs + userOffsetMs);
}

const PREVIEW_LINES = 3;

/** The active line and the next ones (synced), or the first lines (unsynced). Blank lines are skipped. */
export function previewLines(lyrics: Lyrics, timeMs: number, count = PREVIEW_LINES) {
  const from = lyrics.synced ? Math.max(activeLineIndex(lyrics.lines, timeMs), 0) : 0;
  const lines: { line: LyricLine; active: boolean }[] = [];
  const activeIndex = lyrics.synced ? activeLineIndex(lyrics.lines, timeMs) : -1;
  for (let i = from; i < lyrics.lines.length && lines.length < count; i++) {
    const line = lyrics.lines[i]!;
    if (line.text.trim() === "") continue;
    lines.push({ line, active: i === activeIndex });
  }
  return lines;
}

// --- Per-track user offset -------------------------------------------------------------------------

export const OFFSET_STEP_MS = 100;
export const OFFSET_LIMIT_MS = 10_000;
const OFFSET_PREFIX = "navify.lyrics.offset.";

/** Fallback when localStorage is unavailable (private mode, blocked site data). */
const memory = new Map<string, number>();
const listeners = new Set<() => void>();

function clampOffset(ms: number): number {
  return Math.max(
    -OFFSET_LIMIT_MS,
    Math.min(OFFSET_LIMIT_MS, Math.round(ms / OFFSET_STEP_MS) * OFFSET_STEP_MS),
  );
}

/** User offset for a track in ms; positive = lyrics appear later. */
export function getLyricsOffset(trackId: string): number {
  try {
    const raw = localStorage.getItem(OFFSET_PREFIX + trackId);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? clampOffset(value) : 0;
  } catch {
    return memory.get(trackId) ?? 0;
  }
}

export function setLyricsOffset(trackId: string, offsetMs: number): void {
  const value = clampOffset(offsetMs);
  memory.set(trackId, value);
  try {
    if (value === 0) localStorage.removeItem(OFFSET_PREFIX + trackId);
    else localStorage.setItem(OFFSET_PREFIX + trackId, String(value));
  } catch {
    // Kept in memory for this session only.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The per-track offset (ms) plus helpers to nudge it in 0.1 s steps; shared by every component. */
export function useLyricsOffset(trackId: string | undefined) {
  const offsetMs = useSyncExternalStore(
    subscribe,
    () => (trackId ? getLyricsOffset(trackId) : 0),
    () => 0,
  );
  const nudge = useCallback(
    (direction: 1 | -1) => {
      if (trackId) setLyricsOffset(trackId, getLyricsOffset(trackId) + direction * OFFSET_STEP_MS);
    },
    [trackId],
  );
  const reset = useCallback(() => {
    if (trackId) setLyricsOffset(trackId, 0);
  }, [trackId]);
  return { offsetMs, nudge, reset };
}

// --- Smooth playback clock -------------------------------------------------------------------------

/** The store's position may lag the interpolated one by this much before we jump back. */
const HOLD_TOLERANCE_MS = 250;

/**
 * Interpolates between position reports (~10 Hz) with a monotonic wall clock. Pure, so it can be tested
 * without timers.
 */
export class PlaybackClock {
  private basePosition = 0;
  private baseTime = 0;
  private running = false;
  /** Never display less than this until the next report (avoids small jumps backwards). */
  private floor = 0;

  /** Feed a report from the player. `snap` discards interpolation (seek, track change). */
  update(positionMs: number, running: boolean, nowMs: number, snap: boolean): void {
    const estimate = this.now(nowMs);
    const lag = estimate - positionMs;
    this.floor = !snap && running && this.running && lag > 0 && lag < HOLD_TOLERANCE_MS ? estimate : 0;
    this.basePosition = positionMs;
    this.baseTime = nowMs;
    this.running = running;
  }

  now(nowMs: number): number {
    const elapsed = this.running ? Math.max(0, nowMs - this.baseTime) : 0;
    return Math.max(this.basePosition + elapsed, this.floor);
  }
}

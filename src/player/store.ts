import { create } from "zustand";
import type { Track } from "@/api/provider";

/** Where the current queue came from (shown as "Nächster Titel von: …", used for "now playing" highlights). */
export interface PlayContext {
  type: "album" | "playlist" | "artist" | "liked" | "search" | "genre" | "queue" | "mix";
  id?: string;
  name: string;
}

export type RepeatMode = "off" | "all" | "one";
export type ShuffleMode = "off" | "shuffle" | "smart";

interface QueueItem {
  /** Unique per queue entry (the same track may appear twice). */
  key: string;
  track: Track;
  /** Added via "Zur Warteschlange hinzufügen" (plays before the context continues). */
  manual: boolean;
}

interface PlayerState {
  /** Tracks from the play context in context order. */
  context: PlayContext | null;
  contextItems: QueueItem[];
  /** Playback order over `contextItems` indices (identity order unless shuffled). */
  order: number[];
  /** Position in `order` of the current context track. */
  orderIndex: number;
  /** Manually queued items, played before the context continues. */
  manualQueue: QueueItem[];
  /** The playing item (from the context or the manual queue). */
  current: QueueItem | null;
  history: QueueItem[];

  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  buffering: boolean;
  volume: number;
  muted: boolean;
  shuffle: ShuffleMode;
  repeat: RepeatMode;

  playTracks(tracks: Track[], startIndex: number, context: PlayContext): void;
  togglePlay(): void;
  setPlaying(playing: boolean): void;
  next(): void;
  previous(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  cycleRepeat(): void;
  setShuffle(mode: ShuffleMode): void;
  addToQueue(tracks: Track[]): void;
  playNext(tracks: Track[]): void;
  /** Engine/progress updates. */
  setProgress(positionMs: number, durationMs?: number): void;
}

let keyCounter = 0;
const makeItem = (track: Track, manual = false): QueueItem => ({ key: `q${++keyCounter}`, track, manual });

function shuffledOrder(length: number, first: number): number[] {
  const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [first, ...rest];
}

/**
 * Queue and transport state. In milestone 2 this drives the UI only; the native engine is wired to it
 * in milestone 3 (`src/player/engine.ts`), which then reports real positions via `setProgress`.
 */
export const usePlayer = create<PlayerState>((set, get) => ({
  context: null,
  contextItems: [],
  order: [],
  orderIndex: 0,
  manualQueue: [],
  current: null,
  history: [],
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  buffering: false,
  volume: 0.8,
  muted: false,
  shuffle: "off",
  repeat: "off",

  playTracks(tracks, startIndex, context) {
    if (tracks.length === 0) return;
    const items = tracks.map((t) => makeItem(t));
    const start = Math.min(Math.max(startIndex, 0), items.length - 1);
    const order = get().shuffle !== "off" ? shuffledOrder(items.length, start) : items.map((_, i) => i);
    const orderIndex = order.indexOf(start);
    const previous = get().current;
    set({
      context,
      contextItems: items,
      order,
      orderIndex,
      current: items[start] ?? null,
      history: previous ? [previous, ...get().history].slice(0, 100) : get().history,
      isPlaying: true,
      positionMs: 0,
      durationMs: items[start]?.track.durationMs ?? 0,
    });
  },

  togglePlay: () => set({ isPlaying: get().current ? !get().isPlaying : false }),
  setPlaying: (playing) => set({ isPlaying: playing }),

  next() {
    const s = get();
    const history = s.current ? [s.current, ...s.history].slice(0, 100) : s.history;
    if (s.repeat === "one" && s.current) {
      set({ positionMs: 0 });
      return;
    }
    if (s.manualQueue.length > 0) {
      const [nextItem, ...rest] = s.manualQueue;
      set({
        current: nextItem ?? null,
        manualQueue: rest,
        history,
        positionMs: 0,
        durationMs: nextItem?.track.durationMs ?? 0,
      });
      return;
    }
    let orderIndex = s.orderIndex + 1;
    if (orderIndex >= s.order.length) {
      if (s.repeat !== "all") {
        set({ isPlaying: false, positionMs: 0 });
        return;
      }
      orderIndex = 0;
    }
    const item = s.contextItems[s.order[orderIndex] ?? 0] ?? null;
    set({ orderIndex, current: item, history, positionMs: 0, durationMs: item?.track.durationMs ?? 0 });
  },

  previous() {
    const s = get();
    // Restart the current track unless we are within its first 3 seconds (common player behaviour).
    if (s.positionMs > 3000 || s.orderIndex === 0) {
      set({ positionMs: 0 });
      return;
    }
    const orderIndex = s.orderIndex - 1;
    const item = s.contextItems[s.order[orderIndex] ?? 0] ?? null;
    set({ orderIndex, current: item, positionMs: 0, durationMs: item?.track.durationMs ?? 0 });
  },

  seek: (positionMs) => set({ positionMs: Math.max(0, Math.min(positionMs, get().durationMs)) }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)), muted: false }),
  toggleMute: () => set({ muted: !get().muted }),
  cycleRepeat: () => set({ repeat: get().repeat === "off" ? "all" : get().repeat === "all" ? "one" : "off" }),

  setShuffle(mode) {
    const s = get();
    if (s.contextItems.length === 0) {
      set({ shuffle: mode });
      return;
    }
    const currentIndex = s.order[s.orderIndex] ?? 0;
    const order =
      mode !== "off" ? shuffledOrder(s.contextItems.length, currentIndex) : s.contextItems.map((_, i) => i);
    set({ shuffle: mode, order, orderIndex: order.indexOf(currentIndex) });
  },

  addToQueue: (tracks) =>
    set({ manualQueue: [...get().manualQueue, ...tracks.map((t) => makeItem(t, true))] }),
  playNext: (tracks) => set({ manualQueue: [...tracks.map((t) => makeItem(t, true)), ...get().manualQueue] }),

  setProgress: (positionMs, durationMs) =>
    set(durationMs === undefined ? { positionMs } : { positionMs, durationMs }),
}));

/** Upcoming context items after the current one, in play order. */
export function upcomingContextItems(state: PlayerState): QueueItem[] {
  return state.order
    .slice(state.orderIndex + 1)
    .map((i) => state.contextItems[i]!)
    .filter(Boolean);
}

export type { QueueItem, PlayerState };

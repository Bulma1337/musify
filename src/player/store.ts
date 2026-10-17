import { create } from "zustand";
import type { Track } from "@/api/provider";

/** Where the current queue came from (shown as "Als Nächstes aus: …", used for "now playing" highlights). */
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

  /** Incremented when the user starts `current` from `positionMs` (play, next, previous). */
  startNonce: number;
  /** Incremented when the user seeks within `current`. */
  seekNonce: number;

  playTracks(tracks: Track[], startIndex: number, context: PlayContext): void;
  togglePlay(): void;
  setPlaying(playing: boolean): void;
  /** User skips forward (always advances, also with repeat-one). */
  next(): void;
  previous(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  cycleRepeat(): void;
  setShuffle(mode: ShuffleMode): void;
  addToQueue(tracks: Track[]): void;
  playNext(tracks: Track[]): void;
  /** The engine moved on to the queue item `key` by itself (gapless / crossfade / repeat-one). */
  advanceTo(key: string): void;
  /** The engine reached the end and nothing follows. */
  finished(): void;
  /** Engine/progress updates. */
  setProgress(positionMs: number, durationMs?: number): void;
  setBuffering(buffering: boolean): void;
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

const pushHistory = (s: PlayerState) => (s.current ? [s.current, ...s.history].slice(0, 100) : s.history);

/** Where the queue goes after the current item, ignoring repeat-one (user "next"). */
function following(s: PlayerState): { item: QueueItem; manual: boolean; orderIndex: number } | null {
  const manual = s.manualQueue[0];
  if (manual) return { item: manual, manual: true, orderIndex: s.orderIndex };
  let orderIndex = s.orderIndex + 1;
  if (orderIndex >= s.order.length) {
    if (s.repeat !== "all" || s.order.length === 0) return null;
    orderIndex = 0;
  }
  const item = s.contextItems[s.order[orderIndex] ?? -1];
  return item ? { item, manual: false, orderIndex } : null;
}

/**
 * Queue and transport state. The UI changes it; `src/player/bridge.ts` forwards user intent
 * (`startNonce`, `seekNonce`, play/pause, volume) to the audio engine and applies engine events back.
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
  startNonce: 0,
  seekNonce: 0,

  playTracks(tracks, startIndex, context) {
    if (tracks.length === 0) return;
    const items = tracks.map((t) => makeItem(t));
    const start = Math.min(Math.max(startIndex, 0), items.length - 1);
    const order = get().shuffle !== "off" ? shuffledOrder(items.length, start) : items.map((_, i) => i);
    set({
      context,
      contextItems: items,
      order,
      orderIndex: order.indexOf(start),
      current: items[start] ?? null,
      history: pushHistory(get()),
      isPlaying: true,
      positionMs: 0,
      durationMs: items[start]?.track.durationMs ?? 0,
      startNonce: get().startNonce + 1,
    });
  },

  togglePlay: () => set({ isPlaying: get().current ? !get().isPlaying : false }),
  setPlaying: (playing) => set({ isPlaying: playing }),

  next() {
    const s = get();
    const step = following(s);
    if (!step) {
      set({ isPlaying: false, positionMs: 0, seekNonce: s.seekNonce + 1 });
      return;
    }
    set({
      current: step.item,
      manualQueue: step.manual ? s.manualQueue.slice(1) : s.manualQueue,
      orderIndex: step.orderIndex,
      history: pushHistory(s),
      positionMs: 0,
      durationMs: step.item.track.durationMs,
      startNonce: s.startNonce + 1,
    });
  },

  previous() {
    const s = get();
    // Restart the current track unless we are within its first 3 seconds (common player behaviour).
    if (s.positionMs > 3000 || s.orderIndex === 0 || s.current?.manual) {
      set({ positionMs: 0, seekNonce: s.seekNonce + 1 });
      return;
    }
    const orderIndex = s.orderIndex - 1;
    const item = s.contextItems[s.order[orderIndex] ?? 0] ?? null;
    set({
      orderIndex,
      current: item,
      positionMs: 0,
      durationMs: item?.track.durationMs ?? 0,
      startNonce: s.startNonce + 1,
    });
  },

  seek: (positionMs) =>
    set({
      positionMs: Math.max(0, Math.min(positionMs, get().durationMs)),
      seekNonce: get().seekNonce + 1,
    }),
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

  advanceTo(key) {
    const s = get();
    if (s.current?.key === key) {
      // Repeat-one: the same item started again.
      set({ positionMs: 0 });
      return;
    }
    const step = following(s);
    if (!step || step.item.key !== key) return;
    set({
      current: step.item,
      manualQueue: step.manual ? s.manualQueue.slice(1) : s.manualQueue,
      orderIndex: step.orderIndex,
      history: pushHistory(s),
      positionMs: 0,
      durationMs: step.item.track.durationMs,
    });
  },

  finished: () => set({ isPlaying: false, positionMs: 0, buffering: false }),

  setProgress: (positionMs, durationMs) =>
    set(durationMs === undefined ? { positionMs } : { positionMs, durationMs }),
  setBuffering: (buffering) => set({ buffering }),
}));

/** Upcoming context items after the current one, in play order. */
export function upcomingContextItems(state: PlayerState): QueueItem[] {
  return state.order
    .slice(state.orderIndex + 1)
    .map((i) => state.contextItems[i]!)
    .filter(Boolean);
}

/** The item the engine should preload after the current one (repeat-one repeats the current item). */
export function peekNext(state: PlayerState): QueueItem | null {
  if (!state.current) return null;
  if (state.repeat === "one") return state.current;
  return following(state)?.item ?? null;
}

export type { QueueItem, PlayerState };

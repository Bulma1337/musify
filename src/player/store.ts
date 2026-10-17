import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Track } from "@/api/provider";
import { moveItems } from "@/lib/dnd";
import { readPersisted, writePersisted } from "@/lib/persist";
import { useSettings } from "@/settings/store";
import { interleave, shuffleOrder } from "./shuffle";

/** Where the current queue came from (shown as "Als Nächstes aus: …", used for "now playing" highlights). */
export interface PlayContext {
  type: "album" | "playlist" | "artist" | "liked" | "search" | "genre" | "queue" | "mix";
  id?: string;
  name: string;
}

export type RepeatMode = "off" | "all" | "one";
/** "smart" = Shuffle+ (shuffle with recommendations mixed in). */
export type ShuffleMode = "off" | "shuffle" | "smart";

interface QueueItem {
  /** Unique per queue entry (the same track may appear twice). */
  key: string;
  track: Track;
  /** Added via "Zur Warteschlange hinzufügen" (plays before the context continues). */
  manual: boolean;
  /** Added by Shuffle+ or autoplay, not part of the original context. */
  recommended?: boolean;
}

interface PlayerState {
  /** Tracks from the play context in context order (recommendations appended at the end). */
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

  /** Incremented when the user starts `current` from `positionMs` (play, next, previous, jump). */
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
  /** `recommendations` are mixed in for Shuffle+ ("smart"). */
  setShuffle(mode: ShuffleMode, recommendations?: Track[]): void;
  addToQueue(tracks: Track[]): void;
  playNext(tracks: Track[]): void;
  /** Reorders the manually queued items (indices within `manualQueue`). */
  moveManual(from: number[], to: number): void;
  /** Reorders the upcoming context items (indices within `upcomingContextItems`). */
  moveUpcoming(from: number[], to: number): void;
  removeFromQueue(keys: string[]): void;
  clearManualQueue(): void;
  /** Stops playback and empties the whole queue (e.g. when switching to another server). */
  resetQueue(): void;
  /** Plays a queued item now, skipping everything before it. */
  jumpTo(key: string): void;
  /** Appends autoplay recommendations after the context. */
  appendRecommendations(tracks: Track[]): void;
  /** The engine moved on to the queue item `key` by itself (gapless / crossfade / repeat-one). */
  advanceTo(key: string): void;
  /** The engine reached the end and nothing follows. */
  finished(): void;
  /** Engine/progress updates. */
  setProgress(positionMs: number, durationMs?: number): void;
  setBuffering(buffering: boolean): void;
}

let keyCounter = 0;
const makeItem = (track: Track, manual = false, recommended = false): QueueItem => ({
  key: `q${Date.now().toString(36)}${++keyCounter}`,
  track,
  manual,
  ...(recommended ? { recommended: true } : {}),
});

const pushHistory = (s: PlayerState) => (s.current ? [s.current, ...s.history].slice(0, 100) : s.history);

function playOrder(items: QueueItem[], first: number, mode: ShuffleMode): number[] {
  if (mode === "off") return items.map((_, i) => i);
  const algorithm = useSettings.getState().shuffleAlgorithm;
  return shuffleOrder(
    items.map((i) => i.track),
    first,
    algorithm,
  );
}

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

/** Queue state survives restarts (plugin-store file in the app, localStorage in the preview). */
const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("player.json", name)) ?? null,
  setItem: (name, value) => writePersisted("player.json", name, value),
  removeItem: (name) => writePersisted("player.json", name, null),
};

/**
 * Queue and transport state. The UI changes it; `src/player/bridge.ts` forwards user intent
 * (`startNonce`, `seekNonce`, play/pause, volume) to the audio engine and applies engine events back.
 */
export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
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
        // Shuffle+ recommendations belong to one context; a new context starts as plain shuffle.
        const shuffle = get().shuffle === "smart" ? "shuffle" : get().shuffle;
        const order = playOrder(items, start, shuffle);
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
          shuffle,
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
      cycleRepeat: () =>
        set({ repeat: get().repeat === "off" ? "all" : get().repeat === "all" ? "one" : "off" }),

      setShuffle(mode, recommendations = []) {
        const s = get();
        // Drop earlier recommendations (they are always at the end of contextItems).
        const originals = s.contextItems.filter((i) => !i.recommended);
        if (originals.length === 0) {
          set({ shuffle: mode });
          return;
        }
        const currentKey = s.current && !s.current.manual ? s.current.key : undefined;
        const currentIndex = Math.max(
          0,
          originals.findIndex((i) => i.key === currentKey),
        );
        let items = originals;
        let order = playOrder(originals, currentIndex, mode === "off" ? "off" : "shuffle");
        if (mode === "smart" && recommendations.length > 0) {
          const known = new Set(originals.map((i) => i.track.id));
          const extra = recommendations.filter((t) => !known.has(t.id)).map((t) => makeItem(t, false, true));
          items = [...originals, ...extra];
          const extraIndices = extra.map((_, i) => originals.length + i);
          order = [order[0]!, ...interleave(order.slice(1), extraIndices)];
        }
        set({ shuffle: mode, contextItems: items, order, orderIndex: order.indexOf(currentIndex) });
      },

      addToQueue: (tracks) =>
        set({ manualQueue: [...get().manualQueue, ...tracks.map((t) => makeItem(t, true))] }),
      playNext: (tracks) =>
        set({ manualQueue: [...tracks.map((t) => makeItem(t, true)), ...get().manualQueue] }),

      moveManual: (from, to) => set({ manualQueue: moveItems(get().manualQueue, from, to) }),

      moveUpcoming(from, to) {
        const s = get();
        const head = s.order.slice(0, s.orderIndex + 1);
        const upcoming = s.order.slice(s.orderIndex + 1);
        set({ order: [...head, ...moveItems(upcoming, from, to)] });
      },

      removeFromQueue(keys) {
        const s = get();
        const drop = new Set(keys);
        const dropIndices = new Set(
          s.contextItems.map((item, i) => (drop.has(item.key) ? i : -1)).filter((i) => i >= 0),
        );
        const head = s.order.slice(0, s.orderIndex + 1);
        const upcoming = s.order.slice(s.orderIndex + 1).filter((i) => !dropIndices.has(i));
        set({
          manualQueue: s.manualQueue.filter((i) => !drop.has(i.key)),
          order: [...head, ...upcoming],
        });
      },

      clearManualQueue: () => set({ manualQueue: [] }),

      resetQueue: () =>
        set({
          context: null,
          contextItems: [],
          order: [],
          orderIndex: 0,
          manualQueue: [],
          current: null,
          isPlaying: false,
          positionMs: 0,
          durationMs: 0,
          buffering: false,
        }),

      jumpTo(key) {
        const s = get();
        const manualIndex = s.manualQueue.findIndex((i) => i.key === key);
        if (manualIndex >= 0) {
          const item = s.manualQueue[manualIndex]!;
          set({
            current: item,
            manualQueue: s.manualQueue.slice(manualIndex + 1),
            history: pushHistory(s),
            positionMs: 0,
            durationMs: item.track.durationMs,
            isPlaying: true,
            startNonce: s.startNonce + 1,
          });
          return;
        }
        const orderIndex = s.order.findIndex((i) => s.contextItems[i]?.key === key);
        const item = s.contextItems[s.order[orderIndex] ?? -1];
        if (orderIndex < 0 || !item) return;
        set({
          current: item,
          orderIndex,
          history: pushHistory(s),
          positionMs: 0,
          durationMs: item.track.durationMs,
          isPlaying: true,
          startNonce: s.startNonce + 1,
        });
      },

      appendRecommendations(tracks) {
        const s = get();
        const known = new Set([...s.contextItems, ...s.history].map((i) => i.track.id));
        const extra = tracks.filter((t) => !known.has(t.id)).map((t) => makeItem(t, false, true));
        if (extra.length === 0) return;
        const start = s.contextItems.length;
        set({
          contextItems: [...s.contextItems, ...extra],
          order: [...s.order, ...extra.map((_, i) => start + i)],
        });
      },

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
    }),
    {
      name: "navify.player",
      version: 1,
      storage: createJSONStorage(() => storage),
      // Persist the queue and transport settings; never resume playing on startup by itself.
      partialize: (s) => ({
        context: s.context,
        contextItems: s.contextItems,
        order: s.order,
        orderIndex: s.orderIndex,
        manualQueue: s.manualQueue,
        current: s.current,
        positionMs: s.positionMs,
        durationMs: s.durationMs,
        volume: s.volume,
        muted: s.muted,
        shuffle: s.shuffle,
        repeat: s.repeat,
      }),
    },
  ),
);

let upcomingCache: {
  order: PlayerState["order"];
  orderIndex: number;
  items: PlayerState["contextItems"];
  result: QueueItem[];
} | null = null;

/**
 * Upcoming context items after the current one, in play order. Usable as a store selector: the
 * result is cached per input, so an unchanged queue returns the same array (a fresh array on every
 * call makes React re-render forever).
 */
export function upcomingContextItems(state: PlayerState): QueueItem[] {
  const c = upcomingCache;
  if (c && c.order === state.order && c.orderIndex === state.orderIndex && c.items === state.contextItems) {
    return c.result;
  }
  const result = state.order
    .slice(state.orderIndex + 1)
    .map((i) => state.contextItems[i]!)
    .filter(Boolean);
  upcomingCache = { order: state.order, orderIndex: state.orderIndex, items: state.contextItems, result };
  return result;
}

/** The item the engine should preload after the current one (repeat-one repeats the current item). */
export function peekNext(state: PlayerState): QueueItem | null {
  if (!state.current) return null;
  if (state.repeat === "one") return state.current;
  return following(state)?.item ?? null;
}

export type { QueueItem, PlayerState };

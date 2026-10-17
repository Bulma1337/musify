import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Track } from "@/api/provider";
import { inTauri } from "@/lib/platform";
import { downloadsApi } from "./api";
import {
  collectionKey,
  type CollectionEntry,
  type CollectionKind,
  type CollectionSnapshot,
  type DownloadEntry,
  type DownloadState,
  type DownloadUpdate,
  type NativeCollectionRow,
  type NativeListing,
  type NativeTrackRow,
} from "./types";

interface DownloadsState {
  /** Downloads work only inside the desktop app. Tests and the browser preview can flip this. */
  available: boolean;
  /** Server the entries below belong to. */
  serverId: string | null;
  loaded: boolean;
  /** Absolute downloads folder, as reported by the native side. */
  dir: string;
  /** Tracks of the current server by track id. */
  entries: Record<string, DownloadEntry>;
  /** Downloaded albums, playlists and favorites by `collectionKey`. */
  collections: Record<string, CollectionEntry>;

  /** Loads the downloads of a server from the database and starts listening to progress. */
  load(serverId: string, options?: { force?: boolean }): Promise<void>;
  applyUpdates(updates: DownloadUpdate[]): void;
  /** Shows tracks as queued right away, before the native side confirms. */
  markQueued(tracks: Track[], options: { quality: string; individual: boolean }): void;
  putCollection(entry: CollectionEntry): void;
  dropCollection(kind: CollectionKind, itemId?: string): void;
  dropEntries(trackIds: string[]): void;
  setIndividual(trackId: string, individual: boolean): void;
  /** Path of the finished file of a track, or null when it is not downloaded. */
  localPath(serverId: string, trackId: string): string | null;
  reset(): void;
}

function entryFromRow(row: NativeTrackRow): DownloadEntry | null {
  let track: Track;
  try {
    track = JSON.parse(row.trackJson) as Track;
  } catch {
    return null;
  }
  if (!track || typeof track !== "object" || !track.id) return null;
  return {
    track,
    state: row.state,
    quality: row.quality,
    individual: row.individual,
    bytesDone: row.state === "done" ? row.sizeBytes : 0,
    bytesTotal: row.state === "done" ? row.sizeBytes : null,
    error: row.error,
    path: row.state === "done" ? row.absolutePath : null,
    sizeBytes: row.sizeBytes,
    addedAt: row.addedAt,
  };
}

function collectionFromRow(row: NativeCollectionRow): CollectionEntry | null {
  let snapshot: CollectionSnapshot;
  try {
    snapshot = JSON.parse(row.json) as CollectionSnapshot;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    kind: row.kind,
    itemId: row.itemId,
    name: row.name,
    snapshot,
    trackIds: row.trackIds,
    addedAt: row.addedAt,
    syncedAt: row.syncedAt,
  };
}

export function parseListing(listing: NativeListing): {
  entries: Record<string, DownloadEntry>;
  collections: Record<string, CollectionEntry>;
} {
  const entries: Record<string, DownloadEntry> = {};
  for (const row of listing.tracks) {
    const entry = entryFromRow(row);
    if (entry) entries[row.trackId] = entry;
  }
  const collections: Record<string, CollectionEntry> = {};
  for (const row of listing.collections) {
    const entry = collectionFromRow(row);
    if (entry) collections[collectionKey(entry.kind, entry.itemId)] = entry;
  }
  return { entries, collections };
}

let subscribed = false;
const loading = new Map<string, Promise<void>>();

export const useDownloads = create<DownloadsState>()((set, get) => ({
  available: inTauri,
  serverId: null,
  loaded: false,
  dir: "",
  entries: {},
  collections: {},

  async load(serverId, options) {
    const state = get();
    if (state.serverId === serverId && state.loaded && !options?.force) return;
    const pending = loading.get(serverId);
    if (pending) return pending;
    const job = (async () => {
      if (!subscribed) {
        subscribed = true;
        downloadsApi.subscribe((updates) => get().applyUpdates(updates));
      }
      if (get().serverId !== serverId) set({ serverId, loaded: false, entries: {}, collections: {} });
      try {
        const listing = await downloadsApi.list(serverId);
        // The user may have switched servers while the list was loading.
        if (get().serverId !== serverId) return;
        set({ ...parseListing(listing), dir: listing.dir, loaded: true });
      } catch (error) {
        console.error("Could not load the downloads", error);
        if (get().serverId === serverId) set({ loaded: true });
      }
    })().finally(() => loading.delete(serverId));
    loading.set(serverId, job);
    return job;
  },

  applyUpdates(updates) {
    const { serverId, entries } = get();
    let next: Record<string, DownloadEntry> | null = null;
    for (const u of updates) {
      if (u.serverId !== serverId) continue;
      const current = (next ?? entries)[u.trackId];
      if (u.state === "removed") {
        if (!current) continue;
        next ??= { ...entries };
        delete next[u.trackId];
        continue;
      }
      // Updates for tracks we never queued from here (e.g. another window) are picked up by `load`.
      if (!current) continue;
      next ??= { ...entries };
      next[u.trackId] = {
        ...current,
        state: u.state,
        bytesDone: u.state === "done" ? u.sizeBytes : u.bytesDone || current.bytesDone,
        bytesTotal: u.state === "done" ? u.sizeBytes : (u.bytesTotal ?? current.bytesTotal),
        error: u.state === "failed" ? u.error : null,
        path: u.state === "done" ? u.path : null,
        sizeBytes: u.state === "done" ? u.sizeBytes : current.sizeBytes,
      };
    }
    if (next) set({ entries: next });
  },

  markQueued(tracks, { quality, individual }) {
    const { entries } = get();
    const next = { ...entries };
    for (const track of tracks) {
      const current = next[track.id];
      if (current?.state === "done") {
        if (individual && !current.individual) next[track.id] = { ...current, individual: true };
        continue;
      }
      next[track.id] = {
        track,
        state: "queued",
        quality,
        individual: individual || (current?.individual ?? false),
        bytesDone: 0,
        bytesTotal: null,
        error: null,
        path: null,
        sizeBytes: 0,
        addedAt: current?.addedAt ?? Date.now(),
      };
    }
    set({ entries: next });
  },

  putCollection(entry) {
    set({ collections: { ...get().collections, [collectionKey(entry.kind, entry.itemId)]: entry } });
  },

  dropCollection(kind, itemId) {
    const { collections } = get();
    const key = collectionKey(kind, itemId);
    if (!(key in collections)) return;
    const next = { ...collections };
    delete next[key];
    set({ collections: next });
  },

  dropEntries(trackIds) {
    const { entries } = get();
    const next = { ...entries };
    for (const id of trackIds) delete next[id];
    set({ entries: next });
  },

  setIndividual(trackId, individual) {
    const current = get().entries[trackId];
    if (!current) return;
    set({ entries: { ...get().entries, [trackId]: { ...current, individual } } });
  },

  localPath(serverId, trackId) {
    const state = get();
    if (state.serverId !== serverId) return null;
    const entry = state.entries[trackId];
    return entry?.state === "done" ? entry.path : null;
  },

  reset() {
    set({ serverId: null, loaded: false, dir: "", entries: {}, collections: {} });
  },
}));

// --- Derived data ------------------------------------------------------------------------------

/** State of one track's download, or undefined when it is not downloaded. */
export function useTrackDownloadState(trackId: string): DownloadState | undefined {
  return useDownloads((s) => s.entries[trackId]?.state);
}

export interface CollectionStatus {
  /** The collection is registered for download (even if its tracks are still coming in). */
  registered: boolean;
  total: number;
  done: number;
  failed: number;
  /** Tracks still queued or downloading. */
  active: number;
  /** 0…1 over all tracks, counting partial progress of running downloads. */
  progress: number;
}

const EMPTY_STATUS: CollectionStatus = {
  registered: false,
  total: 0,
  done: 0,
  failed: 0,
  active: 0,
  progress: 0,
};

export function collectionStatus(
  state: Pick<DownloadsState, "entries" | "collections">,
  kind: CollectionKind,
  itemId?: string,
): CollectionStatus {
  const collection = state.collections[collectionKey(kind, itemId)];
  if (!collection) return EMPTY_STATUS;
  let done = 0;
  let failed = 0;
  let active = 0;
  let progress = 0;
  for (const id of collection.trackIds) {
    const entry = state.entries[id];
    if (!entry) continue;
    if (entry.state === "done") {
      done++;
      progress += 1;
    } else if (entry.state === "failed") {
      failed++;
    } else {
      active++;
      if (entry.state === "downloading" && entry.bytesTotal) {
        progress += Math.min(1, entry.bytesDone / entry.bytesTotal);
      }
    }
  }
  const total = collection.trackIds.length;
  return { registered: true, total, done, failed, active, progress: total ? progress / total : 1 };
}

export function useCollectionStatus(kind: CollectionKind, itemId?: string): CollectionStatus {
  return useDownloads(useShallow((s) => collectionStatus(s, kind, itemId)));
}

export interface DownloadSummary {
  active: number;
  failed: number;
  done: number;
  /** 0…1 over everything queued or running. */
  progress: number;
}

export function summarize(entries: Record<string, DownloadEntry>): DownloadSummary {
  let active = 0;
  let failed = 0;
  let done = 0;
  let progress = 0;
  for (const entry of Object.values(entries)) {
    if (entry.state === "done") done++;
    else if (entry.state === "failed") failed++;
    else {
      active++;
      if (entry.state === "downloading" && entry.bytesTotal) {
        progress += Math.min(1, entry.bytesDone / entry.bytesTotal);
      }
    }
  }
  return { active, failed, done, progress: active ? progress / active : 0 };
}

export function useDownloadSummary(): DownloadSummary {
  return useDownloads(useShallow((s) => summarize(s.entries)));
}

/** True when downloads work here (desktop app). */
export function useDownloadsAvailable(): boolean {
  return useDownloads((s) => s.available);
}

/** Done tracks of the current server in the order they were added. */
export function doneEntries(entries: Record<string, DownloadEntry>): DownloadEntry[] {
  return Object.values(entries)
    .filter((e) => e.state === "done")
    .sort((a, b) => a.addedAt - b.addedAt);
}

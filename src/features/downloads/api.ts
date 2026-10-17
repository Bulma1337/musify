import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform";
import type {
  CacheInfo,
  CollectionInput,
  DownloadUpdate,
  EnqueueJob,
  MoveProgress,
  NativeListing,
  StorageInfo,
} from "./types";

/**
 * Typed wrapper around the native download and cache commands. Outside the Tauri shell (browser
 * preview, tests) nothing is available: reads return empty data and writes do nothing, so the UI
 * degrades gracefully.
 */
export const downloadsApi = {
  /** Registers the single listener for batched progress updates. */
  subscribe(listener: (updates: DownloadUpdate[]) => void): void {
    if (!inTauri) return;
    const channel = new Channel<DownloadUpdate[]>();
    channel.onmessage = listener;
    void invoke("downloads_subscribe", { onUpdate: channel });
  },

  async list(serverId: string): Promise<NativeListing> {
    if (!inTauri) return { dir: "", tracks: [], collections: [] };
    return invoke<NativeListing>("downloads_list", { serverId });
  },

  async enqueue(jobs: EnqueueJob[]): Promise<void> {
    if (!inTauri || jobs.length === 0) return;
    await invoke("downloads_enqueue", { jobs });
  },

  async setCollection(collection: CollectionInput, jobs: EnqueueJob[]): Promise<void> {
    if (!inTauri) return;
    await invoke("downloads_set_collection", { collection, jobs });
  },

  async removeCollection(serverId: string, kind: string, itemId: string): Promise<void> {
    if (!inTauri) return;
    await invoke("downloads_remove_collection", { serverId, kind, itemId });
  },

  /** False when the track stays because a downloaded collection still contains it. */
  async removeTrack(serverId: string, trackId: string): Promise<boolean> {
    if (!inTauri) return true;
    return invoke<boolean>("downloads_remove_track", { serverId, trackId });
  },

  /** Stops and deletes downloads, whatever collection they belong to. */
  async cancel(serverId: string, trackIds: string[]): Promise<void> {
    if (!inTauri || trackIds.length === 0) return;
    await invoke("downloads_cancel", { serverId, trackIds });
  },

  async removeAll(): Promise<void> {
    if (!inTauri) return;
    await invoke("downloads_remove_all");
  },

  async storageInfo(): Promise<StorageInfo | null> {
    if (!inTauri) return null;
    return invoke<StorageInfo>("downloads_storage_info");
  },

  /** Moves the downloads folder; rejects with "busy" while downloads are running. */
  async setDir(dir: string, onProgress: (progress: MoveProgress) => void): Promise<void> {
    if (!inTauri) return;
    const channel = new Channel<MoveProgress>();
    channel.onmessage = onProgress;
    await invoke("downloads_set_dir", { dir, onProgress: channel });
  },

  /** `src` for the cover saved with a downloaded album (served by the app's own URL scheme). */
  coverSrc(serverId: string, coverRef: string): string {
    if (!inTauri) return "";
    return convertFileSrc(`${serverId}/${coverRef}`, "navdl");
  },
};

/** The engine's streaming cache (separate from downloads). */
export const cacheApi = {
  async info(): Promise<CacheInfo | null> {
    if (!inTauri) return null;
    return invoke<CacheInfo>("audio_cache_info");
  },

  async setLimit(maxBytes: number): Promise<void> {
    if (!inTauri) return;
    await invoke("audio_cache_set_limit", { maxBytes });
  },

  async clear(): Promise<void> {
    if (!inTauri) return;
    await invoke("audio_cache_clear");
  },
};

import type { Album, Playlist, Track } from "@/api/provider";

/** State of one downloaded (or downloading) track. Mirrors `src-tauri/src/downloads`. */
export type DownloadState = "queued" | "downloading" | "done" | "failed";

export type CollectionKind = "album" | "playlist" | "favorites";

/** Where a request comes from; the native side needs the URL and headers per job (kept in memory only). */
export interface NativeSource {
  url: string;
  headers: [string, string][];
  allowInsecureTls: boolean;
}

export interface NativeLayout {
  serverName: string;
  albumArtist: string;
  album: string;
  title: string;
  discNumber?: number;
  trackNumber?: number;
  discTotal?: number;
}

export interface EnqueueJob {
  serverId: string;
  trackId: string;
  quality: string;
  trackJson: string;
  individual: boolean;
  source: NativeSource;
  layout: NativeLayout;
  container: string | null;
  cover: { coverRef: string; source: NativeSource } | null;
}

export interface CollectionInput {
  serverId: string;
  kind: CollectionKind;
  itemId: string;
  name: string;
  json: string;
  trackIds: string[];
}

/** Row as returned by `downloads_list`. */
export interface NativeTrackRow {
  serverId: string;
  trackId: string;
  state: DownloadState;
  path: string | null;
  absolutePath: string | null;
  quality: string;
  container: string | null;
  sizeBytes: number;
  error: string | null;
  individual: boolean;
  trackJson: string;
  addedAt: number;
  completedAt: number | null;
}

export interface NativeCollectionRow {
  serverId: string;
  kind: CollectionKind;
  itemId: string;
  name: string;
  json: string;
  addedAt: number;
  syncedAt: number | null;
  trackIds: string[];
}

export interface NativeListing {
  dir: string;
  tracks: NativeTrackRow[];
  collections: NativeCollectionRow[];
}

/** Progress and state change pushed by the native side (batched, ~10 per second). */
export interface DownloadUpdate {
  serverId: string;
  trackId: string;
  state: DownloadState | "removed";
  bytesDone: number;
  bytesTotal: number | null;
  error: string | null;
  path: string | null;
  sizeBytes: number;
}

export interface StorageInfo {
  dir: string;
  downloadsBytes: number;
  trackCount: number;
  busy: boolean;
}

export interface CacheInfo {
  sizeBytes: number;
  limitBytes: number;
}

export interface MoveProgress {
  movedBytes: number;
  totalBytes: number;
  movedFiles: number;
  totalFiles: number;
  done: boolean;
}

export interface DownloadEntry {
  track: Track;
  state: DownloadState;
  quality: string;
  /** Downloaded on its own, not only as part of an album, playlist or the favorites. */
  individual: boolean;
  bytesDone: number;
  bytesTotal: number | null;
  error: string | null;
  /** Absolute path of the finished file. */
  path: string | null;
  sizeBytes: number;
  addedAt: number;
}

/** Snapshot kept with a collection so it can be browsed offline. */
export type CollectionSnapshot =
  | { kind: "album"; album: Album }
  | { kind: "playlist"; playlist: Playlist }
  | { kind: "favorites"; username?: string };

export interface CollectionEntry {
  kind: CollectionKind;
  itemId: string;
  name: string;
  snapshot: CollectionSnapshot;
  trackIds: string[];
  addedAt: number;
  syncedAt: number | null;
}

export const GIGABYTE = 1024 * 1024 * 1024;

export const collectionKey = (kind: CollectionKind, itemId?: string) => `${kind}:${itemId ?? ""}`;

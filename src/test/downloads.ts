import type { Track } from "@/api/provider";
import { parseListing, useDownloads } from "@/features/downloads/store";
import type {
  CollectionKind,
  CollectionSnapshot,
  DownloadState,
  NativeCollectionRow,
  NativeTrackRow,
} from "@/features/downloads/types";

export function trackRow(
  track: Track,
  state: DownloadState = "done",
  overrides: Partial<NativeTrackRow> = {},
): NativeTrackRow {
  return {
    serverId: track.serverId,
    trackId: track.id,
    state,
    path: state === "done" ? `Test Server/x/${track.id}.flac` : null,
    absolutePath: state === "done" ? `D:/Music/Musify/Test Server/x/${track.id}.flac` : null,
    quality: "original",
    container: "flac",
    sizeBytes: state === "done" ? 30_000_000 : 0,
    error: state === "failed" ? "HTTP status 500" : null,
    individual: false,
    trackJson: JSON.stringify(track),
    addedAt: 1_700_000_000_000,
    completedAt: state === "done" ? 1_700_000_100_000 : null,
    ...overrides,
  };
}

export function collectionRow(
  kind: CollectionKind,
  itemId: string,
  name: string,
  snapshot: CollectionSnapshot,
  trackIds: string[],
): NativeCollectionRow {
  return {
    serverId: "srv1",
    kind,
    itemId,
    name,
    json: JSON.stringify(snapshot),
    addedAt: 1_700_000_000_000,
    syncedAt: null,
    trackIds,
  };
}

/** Puts rows into the downloads store as if they had been loaded from the database. */
export function seedDownloads(
  rows: { tracks?: NativeTrackRow[]; collections?: NativeCollectionRow[] } = {},
  options: { available?: boolean } = {},
) {
  const parsed = parseListing({
    dir: "D:/Music/Musify",
    tracks: rows.tracks ?? [],
    collections: rows.collections ?? [],
  });
  useDownloads.setState({
    available: options.available ?? true,
    serverId: "srv1",
    loaded: true,
    dir: "D:/Music/Musify",
    ...parsed,
  });
}

export function resetDownloads(available = true) {
  useDownloads.setState({
    available,
    serverId: "srv1",
    loaded: true,
    dir: "D:/Music/Musify",
    entries: {},
    collections: {},
  });
}

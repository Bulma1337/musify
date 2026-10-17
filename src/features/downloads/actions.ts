import { ProviderError, type MusicProvider, type Track } from "@/api/provider";
import { QUALITY_PRESETS, useSettings, type QualityPreset } from "@/settings/store";
import { downloadsApi } from "./api";
import { useDownloads } from "./store";
import {
  collectionKey,
  type CollectionKind,
  type CollectionSnapshot,
  type DownloadEntry,
  type EnqueueJob,
  type NativeSource,
} from "./types";

/** `item_id` of the favorites collection (there is only one per server). */
export const FAVORITES_ID = "favorites";

/** The size a cover is saved in: big enough for page headers and the player. */
const COVER_SIZE = 1000;

function presetOf(name: string): QualityPreset {
  return name in QUALITY_PRESETS ? (name as QualityPreset) : "original";
}

function nativeSource(
  provider: MusicProvider,
  source: { url: string; headers: Record<string, string> },
): NativeSource {
  return {
    url: source.url,
    headers: Object.entries(source.headers),
    allowInsecureTls: provider.server.allowInsecureTls ?? false,
  };
}

/** Everything the native downloader needs for one track. The URL carries credentials: memory only. */
export function buildJob(
  provider: MusicProvider,
  track: Track,
  options: { individual: boolean; quality: QualityPreset; discTotal?: number },
): EnqueueJob {
  const preset = QUALITY_PRESETS[options.quality];
  const source = provider.getDownloadSource(track, preset);
  return {
    serverId: provider.server.id,
    trackId: track.id,
    quality: options.quality,
    trackJson: JSON.stringify(track),
    individual: options.individual,
    source: nativeSource(provider, source),
    layout: {
      serverName: provider.server.name,
      albumArtist: track.albumArtists[0]?.name ?? track.artists[0]?.name ?? "",
      album: track.album?.name ?? "",
      title: track.title,
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      discTotal: options.discTotal,
    },
    container: source.container ?? (source.transcoded ? preset.format : track.format.container) ?? null,
    cover: track.cover
      ? {
          coverRef: track.cover,
          source: nativeSource(provider, {
            url: provider.coverUrl(track.cover, COVER_SIZE),
            headers: {},
          }),
        }
      : null,
  };
}

const currentQuality = () => useSettings.getState().downloadQuality;

function discTotal(tracks: Track[]): number | undefined {
  const max = Math.max(0, ...tracks.map((t) => t.discNumber ?? 0));
  return max > 0 ? max : undefined;
}

/** Downloads single tracks (the context menu action). */
export async function downloadTracks(provider: MusicProvider, tracks: Track[]): Promise<void> {
  const store = useDownloads.getState();
  if (!store.available || tracks.length === 0) return;
  await store.load(provider.server.id);
  const quality = currentQuality();
  useDownloads.getState().markQueued(tracks, { quality, individual: true });
  try {
    await downloadsApi.enqueue(tracks.map((t) => buildJob(provider, t, { individual: true, quality })));
  } catch (error) {
    // Show the tracks as not downloaded again, unless they already were.
    useDownloads.getState().dropEntries(tracks.filter((t) => !isDone(t.id)).map((t) => t.id));
    throw error;
  }
}

function isDone(trackId: string): boolean {
  return useDownloads.getState().entries[trackId]?.state === "done";
}

/**
 * Removes the individual download of tracks. Tracks that a downloaded album, playlist or the
 * favorites still contain stay; the result lists them.
 */
export async function removeTrackDownloads(
  serverId: string,
  trackIds: string[],
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of trackIds) {
    if (await downloadsApi.removeTrack(serverId, id)) removed.push(id);
    else kept.push(id);
  }
  const store = useDownloads.getState();
  store.dropEntries(removed);
  for (const id of kept) store.setIndividual(id, false);
  return { removed, kept };
}

/** Stops and deletes downloads that are queued, running or failed (cancel on the downloads page). */
export async function cancelDownloads(serverId: string, trackIds: string[]): Promise<void> {
  await downloadsApi.cancel(serverId, trackIds);
  useDownloads.getState().dropEntries(trackIds);
}

/** Queues a failed download again. */
export async function retryDownload(provider: MusicProvider, trackId: string): Promise<void> {
  const entry = useDownloads.getState().entries[trackId];
  if (!entry) return;
  const quality = presetOf(entry.quality);
  useDownloads.getState().markQueued([entry.track], { quality, individual: entry.individual });
  await downloadsApi.enqueue([buildJob(provider, entry.track, { individual: entry.individual, quality })]);
}

/** Queues all failed downloads again. */
export async function retryAllFailed(provider: MusicProvider): Promise<void> {
  const failed = Object.values(useDownloads.getState().entries).filter((e) => e.state === "failed");
  await retryEntries(provider, failed);
}

async function retryEntries(provider: MusicProvider, entries: DownloadEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const store = useDownloads.getState();
  for (const entry of entries) {
    store.markQueued([entry.track], { quality: presetOf(entry.quality), individual: entry.individual });
  }
  await downloadsApi.enqueue(
    entries.map((e) =>
      buildJob(provider, e.track, { individual: e.individual, quality: presetOf(e.quality) }),
    ),
  );
}

/**
 * After a restart unfinished downloads are queued in the database but nothing is running: build
 * their sources again and hand them to the downloader.
 */
export async function resumePending(provider: MusicProvider): Promise<void> {
  const store = useDownloads.getState();
  await store.load(provider.server.id);
  const pending = Object.values(useDownloads.getState().entries).filter(
    (e) => e.state === "queued" || e.state === "downloading",
  );
  await retryEntries(provider, pending);
}

export interface CollectionSpec {
  kind: CollectionKind;
  itemId: string;
  name: string;
  snapshot: CollectionSnapshot;
  tracks: Track[];
}

/** Downloads (or updates) an album, playlist or the favorites. */
export async function downloadCollection(provider: MusicProvider, spec: CollectionSpec): Promise<void> {
  const store = useDownloads.getState();
  if (!store.available) return;
  await store.load(provider.server.id);
  const quality = currentQuality();
  const discs = spec.kind === "album" ? discTotal(spec.tracks) : undefined;
  const wanted = spec.tracks.filter((t) => !isDone(t.id));
  const previous = useDownloads.getState().collections[collectionKey(spec.kind, spec.itemId)];

  const next = useDownloads.getState();
  next.markQueued(wanted, { quality, individual: false });
  next.putCollection({
    kind: spec.kind,
    itemId: spec.itemId,
    name: spec.name,
    snapshot: spec.snapshot,
    trackIds: spec.tracks.map((t) => t.id),
    addedAt: previous?.addedAt ?? Date.now(),
    syncedAt: Date.now(),
  });
  try {
    await downloadsApi.setCollection(
      {
        serverId: provider.server.id,
        kind: spec.kind,
        itemId: spec.itemId,
        name: spec.name,
        json: JSON.stringify(spec.snapshot),
        trackIds: spec.tracks.map((t) => t.id),
      },
      wanted.map((t) => buildJob(provider, t, { individual: false, quality, discTotal: discs })),
    );
  } catch (error) {
    // Reload the truth from the database.
    await useDownloads.getState().load(provider.server.id, { force: true });
    throw error;
  }
  // A sync may have deleted tracks that dropped out of the collection: reload to reflect that.
  if (previous) await useDownloads.getState().load(provider.server.id, { force: true });
}

export async function removeCollectionDownload(
  serverId: string,
  kind: CollectionKind,
  itemId: string,
): Promise<void> {
  await downloadsApi.removeCollection(serverId, kind, itemId);
  useDownloads.getState().dropCollection(kind, itemId);
  await useDownloads.getState().load(serverId, { force: true });
}

export async function removeAllDownloads(): Promise<void> {
  await downloadsApi.removeAll();
  useDownloads.getState().reset();
}

// --- Syncing with the server -------------------------------------------------------------------------

function sortFavorites(tracks: Track[]): Track[] {
  const time = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0);
  return [...tracks].sort((a, b) => time(b.starredAt) - time(a.starredAt));
}

/** Fetches the current content of a collection from the server. */
export async function fetchCollectionSpec(
  provider: MusicProvider,
  kind: CollectionKind,
  itemId: string,
): Promise<CollectionSpec> {
  switch (kind) {
    case "album": {
      const { tracks, ...album } = await provider.getAlbum(itemId);
      return { kind, itemId, name: album.name, snapshot: { kind, album }, tracks };
    }
    case "playlist": {
      const { tracks, ...playlist } = await provider.getPlaylist(itemId);
      return { kind, itemId, name: playlist.name, snapshot: { kind, playlist }, tracks };
    }
    case "favorites": {
      const starred = await provider.getStarred();
      return {
        kind,
        itemId: FAVORITES_ID,
        name: "favorites",
        snapshot: { kind, username: provider.server.username },
        tracks: sortFavorites(starred.tracks),
      };
    }
  }
}

/**
 * Brings a downloaded collection in line with the server: new tracks are fetched, tracks that
 * were removed are deleted (unless another collection or an individual download needs them).
 */
export async function syncCollection(
  provider: MusicProvider,
  kind: CollectionKind,
  itemId: string,
): Promise<void> {
  const state = useDownloads.getState();
  const existing = state.collections[collectionKey(kind, itemId)];
  if (!existing || !state.available) return;
  const spec = await fetchCollectionSpec(provider, kind, itemId);
  // Keep the localized name of the favorites collection chosen by the UI.
  if (kind === "favorites") spec.name = existing.name;
  const fresh = useDownloads.getState();
  const sameTracks =
    existing.trackIds.length === spec.tracks.length &&
    existing.trackIds.every((id, i) => id === spec.tracks[i]?.id);
  const complete = spec.tracks.every((t) => fresh.entries[t.id]?.state === "done");
  const sameSnapshot =
    existing.name === spec.name && JSON.stringify(existing.snapshot) === JSON.stringify(spec.snapshot);
  if (sameTracks && complete && sameSnapshot) return;
  await downloadCollection(provider, spec);
}

/** Syncs every downloaded collection (app start). Errors of one collection don't stop the others. */
export async function syncAll(provider: MusicProvider): Promise<void> {
  await useDownloads.getState().load(provider.server.id);
  for (const collection of Object.values(useDownloads.getState().collections)) {
    try {
      await syncCollection(provider, collection.kind, collection.itemId);
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === "network" || error.kind === "timeout")) return;
      console.warn("Could not sync a downloaded collection", collection.kind, error);
    }
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const SYNC_DELAY_MS = 1500;

/** Syncs a downloaded collection soon after its content changed on the server (debounced). */
export function scheduleSync(provider: MusicProvider, kind: CollectionKind, itemId: string): void {
  const key = collectionKey(kind, itemId);
  if (!useDownloads.getState().collections[key]) return;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      syncCollection(provider, kind, itemId).catch((error) => {
        console.warn("Could not sync a downloaded collection", kind, error);
      });
    }, SYNC_DELAY_MS),
  );
}

/** Cancels pending syncs (switching servers). */
export function cancelScheduledSyncs(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

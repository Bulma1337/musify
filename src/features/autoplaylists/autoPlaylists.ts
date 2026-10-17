import type { MusicProvider, Track } from "@/api/provider";
import { getHistory, type StatRow } from "@/features/stats/history";
import { prepareHistory } from "@/features/stats/demoHistory";

/**
 * Automatic playlists computed from the listening history (and, for the all-time list, the server's
 * own play counts). They are not stored anywhere: each is a query that can be played as a context
 * or saved as a normal server playlist.
 */

export type AutoKind = "heavyRotation" | "rediscovered" | "allTime" | "topYear";

export interface AutoRef {
  kind: AutoKind;
  /** Calendar year for `topYear`. */
  year?: number;
}

/** Entries per list. */
const LIMITS: Record<AutoKind, number> = { heavyRotation: 50, rediscovered: 50, allTime: 100, topYear: 100 };
/** How many of the server's most played albums are walked for the all-time list. */
const SERVER_ALBUMS = 40;
/** A list needs this many entries to be offered on the home page. */
export const MIN_SHOWN = 5;

const SLUGS = { heavyRotation: "heavy-rotation", rediscovered: "rediscovered", allTime: "all-time" } as const;

/** URL segment and player-context id: "heavy-rotation", "rediscovered", "all-time", "top-2026". */
export function autoSlug(ref: AutoRef): string {
  return ref.kind === "topYear" ? `top-${ref.year}` : SLUGS[ref.kind];
}

export function parseAutoSlug(slug: string | undefined): AutoRef | null {
  if (!slug) return null;
  for (const kind of ["heavyRotation", "rediscovered", "allTime"] as const) {
    if (SLUGS[kind] === slug) return { kind };
  }
  const year = /^top-(\d{4})$/.exec(slug)?.[1];
  return year ? { kind: "topYear", year: Number(year) } : null;
}

export const autoContextId = (ref: AutoRef) => `auto:${autoSlug(ref)}`;

/** One ranked track of an automatic playlist. */
export interface AutoEntry {
  trackId: string;
  plays: number;
  /** Full track when the server walk already returned it. */
  track?: Track;
  /** Local history snapshot, if the track was played here. */
  row?: StatRow;
}

/**
 * Combines the server's play counts with the local history for the all-time ranking.
 *
 * The server count already includes the plays Musify scrobbled, so adding both would count them
 * twice. The larger of the two wins per track: the server count covers other devices and the time
 * before Musify, the local count covers plays the server never learned about (scrobbling off,
 * servers that derive plays differently). Ties keep the server order, then the local order.
 */
export function mergePlayCounts(server: Track[], local: StatRow[], limit: number): AutoEntry[] {
  const entries = new Map<string, AutoEntry>();
  for (const track of server) {
    if (!track.playCount || track.playCount <= 0) continue;
    entries.set(track.id, { trackId: track.id, plays: track.playCount, track });
  }
  for (const row of local) {
    if (!row.id) continue;
    const existing = entries.get(row.id);
    if (existing) {
      existing.plays = Math.max(existing.plays, row.plays);
      existing.row = row;
    } else {
      entries.set(row.id, { trackId: row.id, plays: row.plays, row });
    }
  }
  // Array.sort is stable, so insertion order (server first, then local) breaks ties.
  return [...entries.values()].sort((a, b) => b.plays - a.plays).slice(0, limit);
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Tracks with play counts from the server. Servers have no "top songs" endpoint, so this walks the
 * most played albums (`frequent` on Navidrome) and reads the per-track `playCount`. Failures give
 * an empty list: the all-time ranking then simply rests on the local history.
 */
export async function serverTopTracks(provider: MusicProvider): Promise<Track[]> {
  try {
    const albums = await provider.getAlbumList("mostPlayed", { size: SERVER_ALBUMS });
    const details = await mapLimit(albums, 5, (album) => provider.getAlbum(album.id).catch(() => null));
    return details.flatMap((album) => album?.tracks ?? []);
  } catch {
    return [];
  }
}

export async function loadAutoEntries(
  provider: MusicProvider,
  ref: AutoRef,
  now = new Date(),
): Promise<AutoEntry[]> {
  await prepareHistory(provider);
  const history = getHistory();
  const serverId = provider.server.id;
  const limit = LIMITS[ref.kind];
  const asEntries = (rows: StatRow[]): AutoEntry[] =>
    rows.flatMap((row) => (row.id ? [{ trackId: row.id, plays: row.plays, row }] : []));

  switch (ref.kind) {
    case "heavyRotation":
    case "rediscovered":
      return asEntries(await history.tracks(serverId, { kind: ref.kind, nowMs: now.getTime(), limit }));
    case "topYear": {
      const year = ref.year ?? now.getFullYear();
      return asEntries(
        await history.tracks(serverId, {
          kind: "range",
          nowMs: now.getTime(),
          fromMs: new Date(year, 0, 1).getTime(),
          toMs: new Date(year + 1, 0, 1).getTime(),
          limit,
        }),
      );
    }
    case "allTime": {
      const [server, local] = await Promise.all([
        serverTopTracks(provider),
        history.tracks(serverId, {
          kind: "range",
          nowMs: now.getTime(),
          fromMs: 0,
          toMs: now.getTime() + 1,
          limit,
        }),
      ]);
      return mergePlayCounts(server, local, limit);
    }
  }
}

/** Number of local entries (capped by the list size), for deciding whether to show a list. Cheap: no server calls. */
export async function countLocalEntries(
  provider: MusicProvider,
  ref: AutoRef,
  now = new Date(),
): Promise<number> {
  if (ref.kind !== "allTime") return (await loadAutoEntries(provider, ref, now)).length;
  await prepareHistory(provider);
  const rows = await getHistory().tracks(provider.server.id, {
    kind: "range",
    nowMs: now.getTime(),
    fromMs: 0,
    toMs: now.getTime() + 1,
    limit: MIN_SHOWN,
  });
  return rows.length;
}

/** Full tracks for the entries, in order. Tracks the server no longer knows are left out. */
export async function resolveTracks(provider: MusicProvider, entries: AutoEntry[]): Promise<Track[]> {
  const tracks = await mapLimit(entries, 6, (entry) =>
    entry.track ? Promise.resolve(entry.track) : provider.getTrack(entry.trackId).catch(() => null),
  );
  return tracks.filter((track): track is Track => track !== null);
}

export interface AutoPlaylist {
  entries: AutoEntry[];
  tracks: Track[];
}

export async function loadAutoPlaylist(
  provider: MusicProvider,
  ref: AutoRef,
  now = new Date(),
): Promise<AutoPlaylist> {
  const entries = await loadAutoEntries(provider, ref, now);
  return { entries, tracks: await resolveTracks(provider, entries) };
}

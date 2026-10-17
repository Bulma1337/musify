import type {
  Discoveries,
  HistoryStore,
  MonthStat,
  PlayRecord,
  StatRow,
  Streak,
  Summary,
  TrackListQuery,
} from "./history";

/**
 * In-memory history for tests and the browser preview. It answers the same queries as the SQL in
 * `src-tauri/src/stats/queries.rs` and follows the same rules:
 * - a *play* is a row with `counted`; *minutes* sum `playedMs` of all rows (skips were heard too)
 * - time-of-day, days and months use the UTC offset recorded with each row
 * - ranges are half-open `[from, to)`
 */

export const DAY_MS = 86_400_000;
const HEAVY_ROTATION_DAYS = 30;
const HEAVY_ROTATION_MIN_PLAYS = 2;
const REDISCOVER_OLDER_THAN_DAYS = 182;
const REDISCOVER_QUIET_DAYS = 61;
const REDISCOVER_MIN_PLAYS = 3;

type Group = "track" | "artist" | "album" | "genre";

const groupKey: Record<Group, (r: PlayRecord) => string | undefined> = {
  track: (r) => r.trackId,
  artist: (r) => (r.artist ? (r.artistId ?? r.artist) : undefined),
  album: (r) => r.albumId,
  genre: (r) => r.genre || undefined,
};

function toStat(group: Group, latest: PlayRecord, plays: number, playedMs: number): StatRow {
  const base = {
    artist: latest.artist,
    artistId: latest.artistId ?? null,
    album: latest.album ?? null,
    albumId: latest.albumId ?? null,
    genre: latest.genre ?? null,
    cover: latest.cover ?? null,
    plays,
    playedMs,
    lastPlayedAt: latest.startedAt,
  };
  switch (group) {
    case "track":
      return { id: latest.trackId, title: latest.title, ...base };
    case "artist":
      return { id: latest.artistId ?? null, title: latest.artist, ...base };
    case "album":
      return { id: latest.albumId ?? null, title: latest.album ?? "", ...base };
    case "genre":
      return { id: null, title: latest.genre ?? "", ...base };
  }
}

/** Groups rows, ranks by plays then minutes, and drops groups without a counted play. */
function topGroups(
  rows: PlayRecord[],
  group: Group,
  limit: number,
  minPlays = 1,
  include: (key: string) => boolean = () => true,
): StatRow[] {
  const groups = new Map<string, { latest: PlayRecord; plays: number; ms: number }>();
  for (const row of rows) {
    const key = groupKey[group](row);
    if (key === undefined || !include(key)) continue;
    const entry = groups.get(key);
    if (!entry) {
      groups.set(key, { latest: row, plays: row.counted ? 1 : 0, ms: row.playedMs });
    } else {
      entry.plays += row.counted ? 1 : 0;
      entry.ms += row.playedMs;
      if (row.startedAt >= entry.latest.startedAt) entry.latest = row;
    }
  }
  return [...groups.entries()]
    .filter(([, g]) => g.plays >= Math.max(1, minPlays))
    .sort(([ka, a], [kb, b]) => b.plays - a.plays || b.ms - a.ms || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, limit)
    .map(([, g]) => toStat(group, g.latest, g.plays, g.ms));
}

const localSecs = (r: PlayRecord) => Math.floor(r.startedAt / 1000) + r.tzOffsetMin * 60;
const localDate = (r: PlayRecord) => new Date(localSecs(r) * 1000);

/** Longest run of consecutive local days; ties keep the earliest. */
export function longestStreak(sortedDays: number[]): Streak {
  let best: Streak = { days: 0, startDay: 0, endDay: 0 };
  let runStart = 0;
  let previous: number | undefined;
  for (const day of sortedDays) {
    if (previous !== day - 1) runStart = day;
    const length = day - runStart + 1;
    if (length > best.days) best = { days: length, startDay: runStart, endDay: day };
    previous = day;
  }
  return best;
}

function discoveries(
  all: PlayRecord[],
  inRange: PlayRecord[],
  from: number,
  to: number,
  limit: number,
): Discoveries {
  const firstTrack = new Map<string, number>();
  const firstArtist = new Map<string, number>();
  for (const r of all) {
    if (!r.counted) continue;
    const t = firstTrack.get(r.trackId);
    if (t === undefined || r.startedAt < t) firstTrack.set(r.trackId, r.startedAt);
    const artist = groupKey.artist(r);
    if (artist !== undefined) {
      const a = firstArtist.get(artist);
      if (a === undefined || r.startedAt < a) firstArtist.set(artist, r.startedAt);
    }
  }
  const within = (ms: number) => ms >= from && ms < to;
  const newTracks = new Set([...firstTrack].filter(([, ms]) => within(ms)).map(([id]) => id));
  return {
    tracks: newTracks.size,
    artists: [...firstArtist.values()].filter(within).length,
    top: topGroups(inRange, "track", limit, 1, (id) => newTracks.has(id)),
  };
}

export class MemoryHistory implements HistoryStore {
  private rows: PlayRecord[] = [];

  async record(play: PlayRecord) {
    this.rows.push({ ...play, playedMs: Math.max(0, play.playedMs) });
  }

  /** Adds many rows at once (preview seeding, tests). */
  addAll(rows: PlayRecord[]) {
    for (const row of rows) this.rows.push(row);
  }

  /** Replaces everything. */
  replaceAll(rows: PlayRecord[]) {
    this.rows = [...rows];
  }

  clear() {
    this.rows = [];
  }

  count(serverId?: string): number {
    return serverId ? this.rows.filter((r) => r.serverId === serverId).length : this.rows.length;
  }

  async summary(serverId: string, from: number, to: number, topLimit: number): Promise<Summary> {
    const server = this.rows.filter((r) => r.serverId === serverId);
    const rows = server.filter((r) => r.startedAt >= from && r.startedAt < to);
    const counted = rows.filter((r) => r.counted);

    const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const months = new Map<string, MonthStat>();
    for (const r of rows) {
      const d = localDate(r);
      // getUTCDay: Sunday = 0; shift so Monday = 0.
      const row = heatmap[(d.getUTCDay() + 6) % 7]!;
      row[d.getUTCHours()]! += r.playedMs;
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const entry = months.get(month) ?? { month, playedMs: 0, plays: 0 };
      entry.playedMs += r.playedMs;
      entry.plays += r.counted ? 1 : 0;
      months.set(month, entry);
    }
    const days = [...new Set(counted.map((r) => Math.floor(localSecs(r) / 86400)))].sort((a, b) => a - b);
    const daily = new Map<number, number>();
    for (const r of rows) {
      const day = Math.floor(localSecs(r) / 86400);
      daily.set(day, (daily.get(day) ?? 0) + r.playedMs);
    }

    return {
      playedMs: rows.reduce((sum, r) => sum + r.playedMs, 0),
      plays: counted.length,
      skips: rows.filter((r) => r.skipped).length,
      distinctTracks: new Set(counted.map((r) => r.trackId)).size,
      activeDays: days.length,
      topTracks: topGroups(rows, "track", topLimit),
      topArtists: topGroups(rows, "artist", topLimit),
      topAlbums: topGroups(rows, "album", topLimit),
      topGenres: topGroups(rows, "genre", topLimit),
      heatmap,
      longestStreak: longestStreak(days),
      discoveries: discoveries(server, rows, from, to, topLimit),
      months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
      daily: [...daily.entries()].sort((a, b) => a[0] - b[0]).map(([day, playedMs]) => ({ day, playedMs })),
    };
  }

  async tracks(serverId: string, q: TrackListQuery): Promise<StatRow[]> {
    const server = this.rows.filter((r) => r.serverId === serverId);
    const between = (from: number, to: number) =>
      server.filter((r) => r.startedAt >= from && r.startedAt < to);
    switch (q.kind) {
      case "range":
        return topGroups(between(q.fromMs ?? 0, q.toMs ?? Number.MAX_SAFE_INTEGER), "track", q.limit);
      case "heavyRotation":
        return topGroups(
          between(q.nowMs - HEAVY_ROTATION_DAYS * DAY_MS, q.nowMs + 1),
          "track",
          q.limit,
          HEAVY_ROTATION_MIN_PLAYS,
        );
      case "rediscovered": {
        const quietFrom = q.nowMs - REDISCOVER_QUIET_DAYS * DAY_MS;
        const recent = new Set(
          server.filter((r) => r.counted && r.startedAt >= quietFrom).map((r) => r.trackId),
        );
        return topGroups(
          between(0, q.nowMs - REDISCOVER_OLDER_THAN_DAYS * DAY_MS),
          "track",
          q.limit,
          REDISCOVER_MIN_PLAYS,
          (id) => !recent.has(id),
        );
      }
    }
  }

  async years(serverId: string): Promise<number[]> {
    const years = new Set(
      this.rows.filter((r) => r.serverId === serverId && r.counted).map((r) => localDate(r).getUTCFullYear()),
    );
    return [...years].sort((a, b) => a - b);
  }
}

/** The shared instance used outside the app (browser preview, tests). */
export const memoryHistory = new MemoryHistory();

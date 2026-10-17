import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform";
import { memoryHistory } from "./memoryHistory";

/**
 * Local listening history. Rows hold server id, item ids and a metadata snapshot, never URLs.
 * The app uses the SQLite-backed implementation (Rust commands in `src-tauri/src/stats`); tests and
 * the browser preview use the in-memory one, which answers the same queries.
 */

/** One finished playback, as stored. Times are Unix ms (UTC). */
export interface PlayRecord {
  serverId: string;
  trackId: string;
  startedAt: number;
  /** Time actually heard (pauses excluded, seeks not counted). */
  playedMs: number;
  durationMs: number;
  completed: boolean;
  /** Not completed and not counted as a play. */
  skipped: boolean;
  /** Counts as a play by the scrobble rule. */
  counted: boolean;
  contextType?: string;
  contextId?: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  genre?: string;
  cover?: string;
  /** Local UTC offset in minutes when the track was played. */
  tzOffsetMin: number;
}

/**
 * One entry of a top list. `id`/`title` mean: track (track id, title), artist (artist id, name),
 * album (album id, name), genre (none, name).
 */
export interface StatRow {
  id: string | null;
  title: string;
  artist: string | null;
  artistId: string | null;
  album: string | null;
  albumId: string | null;
  genre: string | null;
  cover: string | null;
  plays: number;
  playedMs: number;
  lastPlayedAt: number;
}

export interface Streak {
  days: number;
  /** Local day numbers (days since 1970-01-01). */
  startDay: number;
  endDay: number;
}

export interface MonthStat {
  /** "2026-03" in local time. */
  month: string;
  playedMs: number;
  plays: number;
}

export interface Discoveries {
  /** Tracks whose first play ever falls into the range. */
  tracks: number;
  /** Artists whose first play ever falls into the range. */
  artists: number;
  top: StatRow[];
}

export interface Summary {
  playedMs: number;
  plays: number;
  skips: number;
  distinctTracks: number;
  activeDays: number;
  topTracks: StatRow[];
  topArtists: StatRow[];
  topAlbums: StatRow[];
  topGenres: StatRow[];
  /** Listening time in ms by weekday (Monday = 0) and local hour. */
  heatmap: number[][];
  longestStreak: Streak;
  discoveries: Discoveries;
  months: MonthStat[];
}

export type TrackListKind = "heavyRotation" | "rediscovered" | "range";

export interface TrackListQuery {
  kind: TrackListKind;
  /** Reference time for the relative kinds. */
  nowMs: number;
  /** Bounds for `range`. */
  fromMs?: number;
  toMs?: number;
  limit: number;
}

export interface HistoryStore {
  /** Stores one finished playback. */
  record(play: PlayRecord): Promise<void>;
  /** Everything the Stats page and the Recap show for `[fromMs, toMs)`. */
  summary(serverId: string, fromMs: number, toMs: number, topLimit: number): Promise<Summary>;
  /** Ranked local tracks for the automatic playlists. */
  tracks(serverId: string, query: TrackListQuery): Promise<StatRow[]>;
  /** Local calendar years with plays, ascending. */
  years(serverId: string): Promise<number[]>;
}

/** SQLite via the Rust backend. */
class NativeHistory implements HistoryStore {
  async record(play: PlayRecord) {
    await invoke("history_record", { play });
  }

  summary(serverId: string, fromMs: number, toMs: number, topLimit: number) {
    return invoke<Summary>("stats_summary", { serverId, fromMs, toMs, topLimit });
  }

  tracks(serverId: string, q: TrackListQuery) {
    return invoke<StatRow[]>("stats_tracks", {
      serverId,
      kind: q.kind,
      nowMs: q.nowMs,
      fromMs: q.fromMs ?? 0,
      toMs: q.toMs ?? 0,
      limit: q.limit,
    });
  }

  years(serverId: string) {
    return invoke<number[]>("stats_years", { serverId });
  }
}

let native: HistoryStore | null = null;

/** The history for this window: native in the app, in-memory in the browser preview and in tests. */
export function getHistory(): HistoryStore {
  if (!inTauri) return memoryHistory;
  native ??= new NativeHistory();
  return native;
}

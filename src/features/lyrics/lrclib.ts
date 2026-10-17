import { httpJson } from "@/api/http";
import type { Lyrics, Track } from "@/api/provider";
import { ProviderError } from "@/api/provider";
import { parseLrc } from "./lrc";

const BASE_URL = "https://lrclib.net/api";
const CLIENT_HEADER = "Musify 0.1.0 (https://github.com/Bulma1337/musify)";
const TIMEOUT_MS = 8_000;
/** Accepted difference between our track length and a search hit, in seconds. */
const DURATION_TOLERANCE_S = 3;

/** One record as returned by LRCLIB. */
interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  /** Seconds. */
  duration?: number | null;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LrclibResult {
  /** Null when LRCLIB has nothing usable for the track. */
  lyrics: Lyrics | null;
  /** LRCLIB marks the track as instrumental (there are no lyrics to find). */
  instrumental: boolean;
}

const NOTHING: LrclibResult = { lyrics: null, instrumental: false };

function request<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  return httpJson<T>(`${BASE_URL}${path}?${query}`, {
    headers: { "Lrclib-Client": CLIENT_HEADER },
    timeoutMs: TIMEOUT_MS,
    signal,
  });
}

function toResult(record: LrclibRecord): LrclibResult {
  if (record.instrumental) return { lyrics: null, instrumental: true };
  if (record.syncedLyrics) {
    const synced = parseLrc(record.syncedLyrics, "lrclib");
    if (synced?.synced) return { lyrics: synced, instrumental: false };
  }
  if (record.plainLyrics) {
    const plain = parseLrc(record.plainLyrics, "lrclib");
    if (plain) return { lyrics: plain, instrumental: false };
  }
  return NOTHING;
}

/** Best search hit: duration within ±3 s, synced preferred, then the closest duration. */
function pickBest(records: LrclibRecord[], durationS: number): LrclibRecord | null {
  const candidates = records
    .filter((r) => typeof r.duration === "number" && Math.abs(r.duration - durationS) <= DURATION_TOLERANCE_S)
    .filter((r) => r.instrumental || r.syncedLyrics || r.plainLyrics);
  if (candidates.length === 0) return null;
  const score = (r: LrclibRecord) =>
    (r.syncedLyrics && !r.instrumental ? 0 : 1000) + Math.abs((r.duration ?? 0) - durationS);
  return candidates.reduce((best, r) => (score(r) < score(best) ? r : best));
}

/**
 * Looks lyrics up on LRCLIB: exact match via `/api/get`, then `/api/search` as fallback on 404.
 * Network errors, timeouts and unexpected answers all count as "no lyrics".
 */
export async function fetchLrclib(track: Track, signal?: AbortSignal): Promise<LrclibResult> {
  const artist = track.artists[0]?.name ?? track.artistLine;
  const durationS = Math.round(track.durationMs / 1000);
  const params: Record<string, string> = { track_name: track.title, artist_name: artist };
  if (track.album?.name) params.album_name = track.album.name;
  if (durationS > 0) params.duration = String(durationS);

  try {
    return toResult(await request<LrclibRecord>("/get", params, signal));
  } catch (error) {
    if (!(error instanceof ProviderError) || error.kind !== "notFound") return NOTHING;
  }

  try {
    const hits = await request<LrclibRecord[]>(
      "/search",
      { track_name: track.title, artist_name: artist },
      signal,
    );
    if (!Array.isArray(hits) || durationS <= 0) return NOTHING;
    const best = pickBest(hits, durationS);
    return best ? toResult(best) : NOTHING;
  } catch {
    return NOTHING;
  }
}

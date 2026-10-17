import type { Track } from "@/api/provider";
import { getHistory, type PlayRecord } from "./history";

/** Where the playback came from, as captured when the track started. */
export interface PlaybackContextInfo {
  type?: string;
  id?: string;
}

/** Shorter listens carry no signal (instant skips, engine hiccups) and are not stored. */
const MIN_RECORDED_MS = 1000;

/** Builds the stored row for a finished playback (metadata snapshot, no URLs). */
export function buildPlayRecord(
  track: Track,
  info: {
    startedAt: number;
    playedMs: number;
    completed: boolean;
    /** Counts as a play by the scrobble rule (`shouldScrobble` in the player bridge). */
    counted: boolean;
    context?: PlaybackContextInfo;
    tzOffsetMin?: number;
  },
): PlayRecord {
  const { counted } = info;
  return {
    serverId: track.serverId,
    trackId: track.id,
    startedAt: info.startedAt,
    playedMs: Math.round(info.playedMs),
    durationMs: track.durationMs,
    completed: info.completed,
    counted,
    skipped: !info.completed && !counted,
    contextType: info.context?.type,
    contextId: info.context?.id,
    title: track.title,
    artist: track.artists[0]?.name ?? track.artistLine,
    artistId: track.artists[0]?.id,
    album: track.album?.name,
    albumId: track.album?.id,
    genre: track.genres[0],
    cover: track.cover,
    // getTimezoneOffset is UTC minus local, so negate it.
    tzOffsetMin: info.tzOffsetMin ?? -new Date(info.startedAt).getTimezoneOffset(),
  };
}

/**
 * Records a finished playback. Fire and forget: failures are only logged and never reach playback.
 */
export function recordPlay(
  track: Track,
  info: Parameters<typeof buildPlayRecord>[1],
  store = getHistory(),
): void {
  if (info.playedMs < MIN_RECORDED_MS) return;
  try {
    store.record(buildPlayRecord(track, info)).catch((error: unknown) => {
      console.warn("Could not record the play:", String(error));
    });
  } catch (error) {
    console.warn("Could not record the play:", String(error));
  }
}

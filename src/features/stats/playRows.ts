import type { MusicProvider } from "@/api/provider";
import { resolveTracks } from "@/features/autoplaylists/autoPlaylists";
import { loaders, playOrToggle } from "@/player/actions";
import { usePlayer, type PlayContext } from "@/player/store";
import type { StatRow } from "./history";

/**
 * Plays a top list of tracks starting at `start`. History rows only hold a snapshot, so the full
 * tracks are fetched first; tracks the server no longer has are skipped.
 */
export async function playTrackRows(
  provider: MusicProvider,
  rows: StatRow[],
  start: StatRow,
  context: PlayContext,
): Promise<void> {
  const entries = rows.flatMap((row) => (row.id ? [{ trackId: row.id, plays: row.plays }] : []));
  const tracks = await resolveTracks(provider, entries);
  const index = tracks.findIndex((track) => track.id === start.id);
  usePlayer.getState().playTracks(tracks, Math.max(0, index), context);
}

/** Plays an artist's or album's usual playback (same as the play buttons on their pages). */
export function playRow(provider: MusicProvider, kind: "artist" | "album", row: StatRow) {
  if (!row.id) return;
  if (kind === "album") {
    playOrToggle({ type: "album", id: row.id, name: row.title }, loaders.album(provider, row.id));
  } else {
    playOrToggle(
      { type: "artist", id: row.id, name: row.title },
      loaders.artist(provider, row.id, row.title),
    );
  }
}

import type { QueryClient } from "@tanstack/react-query";
import type { MusicProvider, Playlist, Track } from "@/api/provider";
import { formatDate } from "@/lib/format";
import type { AutoRef } from "./autoPlaylists";

/** Name of the server playlist created by "save": year lists are stable, the others get the date. */
export function savedPlaylistName(title: string, auto: AutoRef, now = new Date()): string {
  return auto.kind === "topYear" ? title : `${title} · ${formatDate(now.toISOString())}`;
}

/** Creates a normal server playlist from the tracks of an automatic one. */
export async function saveAutoPlaylist(
  provider: MusicProvider,
  client: QueryClient,
  name: string,
  tracks: Track[],
): Promise<Playlist> {
  const playlist = await provider.createPlaylist(
    name,
    tracks.map((track) => track.id),
  );
  await client.invalidateQueries({ queryKey: [provider.server.id, "playlists"] });
  return playlist;
}

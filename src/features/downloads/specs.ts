import type { AlbumDetail, PlaylistDetail, Track } from "@/api/provider";
import { FAVORITES_ID, type CollectionSpec } from "./actions";

export function albumSpec(detail: AlbumDetail): CollectionSpec {
  const { tracks, ...album } = detail;
  return {
    kind: "album",
    itemId: album.id,
    name: album.name,
    snapshot: { kind: "album", album },
    tracks,
  };
}

export function playlistSpec(detail: PlaylistDetail): CollectionSpec {
  const { tracks, ...playlist } = detail;
  return {
    kind: "playlist",
    itemId: playlist.id,
    name: playlist.name,
    snapshot: { kind: "playlist", playlist },
    tracks,
  };
}

/** `name` is the localized title ("Favoriten") shown in the library and on the downloads page. */
export function favoritesSpec(tracks: Track[], name: string, username?: string): CollectionSpec {
  return {
    kind: "favorites",
    itemId: FAVORITES_ID,
    name,
    snapshot: { kind: "favorites", username },
    tracks,
  };
}

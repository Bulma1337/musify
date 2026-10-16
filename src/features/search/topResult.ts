import type { Album, Artist, SearchResult, Track } from "@/api/provider";

export type TopResult =
  { type: "artist"; item: Artist } | { type: "album"; item: Album } | { type: "track"; item: Track };

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Picks the best match for the "Top result" card: an exact artist/album name first, then a name that
 * starts with the query (artists before albums), otherwise the first track, then whatever else exists.
 */
export function pickTopResult(result: SearchResult, query: string): TopResult | null {
  const q = norm(query);
  if (q) {
    const exactArtist = result.artists.find((a) => norm(a.name) === q);
    if (exactArtist) return { type: "artist", item: exactArtist };
    const exactAlbum = result.albums.find((a) => norm(a.name) === q);
    if (exactAlbum) return { type: "album", item: exactAlbum };
    const prefixArtist = result.artists.find((a) => norm(a.name).startsWith(q));
    if (prefixArtist) return { type: "artist", item: prefixArtist };
    const prefixAlbum = result.albums.find((a) => norm(a.name).startsWith(q));
    if (prefixAlbum) return { type: "album", item: prefixAlbum };
  }
  const track = result.tracks[0];
  if (track) return { type: "track", item: track };
  const artist = result.artists[0];
  if (artist) return { type: "artist", item: artist };
  const album = result.albums[0];
  if (album) return { type: "album", item: album };
  return null;
}

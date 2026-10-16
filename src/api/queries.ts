import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import type { AlbumListType, StarrableKind } from "./provider";
import { useProvider } from "./session";

/**
 * TanStack Query hooks for server data. Keys always start with the server id so switching servers
 * never shows stale data from another library.
 */

export function useAlbumList(type: AlbumListType, size = 20, extra?: { genre?: string }) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "albumList", type, size, extra?.genre],
    queryFn: () => provider.getAlbumList(type, { size, genre: extra?.genre }),
    // "random" should feel fresh on every visit.
    staleTime: type === "random" ? 0 : undefined,
  });
}

export function useAlbum(id: string | undefined) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "album", id],
    queryFn: () => provider.getAlbum(id!),
    enabled: !!id,
  });
}

export function useArtist(id: string | undefined) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "artist", id],
    queryFn: () => provider.getArtist(id!),
    enabled: !!id,
  });
}

export function useArtistInfo(id: string | undefined) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "artistInfo", id],
    queryFn: () => provider.getArtistInfo(id!),
    enabled: !!id && provider.capabilities.artistInfo,
    staleTime: 24 * 60 * 60_000,
  });
}

export function useTopTracks(artistName: string | undefined, artistId?: string) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "topTracks", artistId ?? artistName],
    queryFn: () => provider.getTopTracks({ id: artistId, name: artistName! }, 10),
    enabled: !!artistName && provider.capabilities.topTracks,
  });
}

export function usePlaylists() {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "playlists"],
    queryFn: () => provider.getPlaylists(),
  });
}

export function usePlaylist(id: string | undefined) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "playlist", id],
    queryFn: () => provider.getPlaylist(id!),
    enabled: !!id,
  });
}

export function useStarred() {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "starred"],
    queryFn: () => provider.getStarred(),
  });
}

export function useGenres() {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "genres"],
    queryFn: () => provider.getGenres(),
    staleTime: 60 * 60_000,
  });
}

export function useSearch(query: string) {
  const provider = useProvider();
  const trimmed = query.trim();
  return useQuery({
    queryKey: [provider.server.id, "search", trimmed],
    queryFn: () => provider.search(trimmed, { artists: 12, albums: 12, tracks: 25 }),
    enabled: trimmed.length > 0,
    placeholderData: (previous) => previous,
  });
}

/** Star/unstar with optimistic invalidation of everything that shows favorite state. */
export function useSetStarred() {
  const provider = useProvider();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, starred }: { kind: StarrableKind; id: string; starred: boolean }) =>
      provider.setStarred(kind, id, starred),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [provider.server.id] });
    },
  });
}

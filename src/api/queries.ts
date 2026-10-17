import { useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import type { AlbumListType, Playlist, PlaylistDetail, StarrableKind } from "./provider";
import { useCustomCovers, withCustomCover } from "./customCovers";
import { useProvider } from "./session";
import { resolveStarred, starredChange, useStarredChanges } from "./starred";

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
  const images = useCustomCovers((s) => s.images);
  const select = useCallback((list: Playlist[]) => list.map((p) => withCustomCover(p, images)), [images]);
  return useQuery({
    queryKey: [provider.server.id, "playlists"],
    queryFn: () => provider.getPlaylists(),
    select,
  });
}

export function usePlaylist(id: string | undefined) {
  const provider = useProvider();
  const images = useCustomCovers((s) => s.images);
  const select = useCallback((playlist: PlaylistDetail) => withCustomCover(playlist, images), [images]);
  return useQuery({
    queryKey: [provider.server.id, "playlist", id],
    queryFn: () => provider.getPlaylist(id!),
    enabled: !!id,
    select,
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
  const serverId = provider.server.id;
  return useMutation({
    mutationFn: ({ kind, id, starred }: { kind: StarrableKind; id: string; starred: boolean }) =>
      provider.setStarred(kind, id, starred),
    // Shown everywhere at once (player bar, lists, panels); undone if the server refuses.
    onMutate: ({ kind, id, starred }) => {
      const previous = starredChange(serverId, kind, id);
      useStarredChanges.getState().set(serverId, kind, id, starred);
      return { previous };
    },
    onError: (_error, { kind, id }, context) => {
      useStarredChanges.getState().restore(serverId, kind, id, context?.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [provider.server.id] });
    },
  });
}

/** Whether an item is a favorite, including changes made here that the loaded data does not show yet. */
export function useIsStarred(kind: StarrableKind, id: string | undefined, fallback: boolean | undefined) {
  const serverId = useProvider().server.id;
  return useStarredChanges((s) => resolveStarred(s.changes, serverId, kind, id, fallback));
}

/** Like {@link useIsStarred} for many items at once (track lists, menus). */
export function useStarredResolver() {
  const serverId = useProvider().server.id;
  const changes = useStarredChanges((s) => s.changes);
  return useCallback(
    (kind: StarrableKind, id: string | undefined, fallback: boolean | undefined) =>
      resolveStarred(changes, serverId, kind, id, fallback),
    [changes, serverId],
  );
}

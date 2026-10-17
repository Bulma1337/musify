import { queryOptions, useQuery } from "@tanstack/react-query";
import type { MusicProvider } from "@/api/provider";
import { useProvider } from "@/api/session";
import { autoSlug, countLocalEntries, loadAutoPlaylist, MIN_SHOWN, type AutoRef } from "./autoPlaylists";

/** Shared by the page, the play buttons on the home cards and "save as playlist". */
export function autoPlaylistQuery(provider: MusicProvider, ref: AutoRef) {
  return queryOptions({
    queryKey: [provider.server.id, "autoPlaylist", autoSlug(ref)],
    queryFn: () => loadAutoPlaylist(provider, ref),
    staleTime: 2 * 60_000,
  });
}

export function useAutoPlaylist(ref: AutoRef | null) {
  const provider = useProvider();
  return useQuery({
    ...autoPlaylistQuery(provider, ref ?? { kind: "heavyRotation" }),
    enabled: ref !== null,
  });
}

/** Whether the local history is enough for a list, without resolving tracks or calling the server (home shelf). */
export function useAutoAvailable(ref: AutoRef) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "autoPlaylistProbe", autoSlug(ref)],
    queryFn: async () => (await countLocalEntries(provider, ref)) >= MIN_SHOWN,
    staleTime: 2 * 60_000,
  });
}

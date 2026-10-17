import type { MusicProvider, Track } from "@/api/provider";
import { usePlayer, type PlayContext } from "./store";

/** True while the given context (album, playlist, …) is the one currently playing. */
export function useIsContextPlaying(type: PlayContext["type"], id?: string): boolean {
  return usePlayer((s) => s.isPlaying && s.context?.type === type && s.context.id === id);
}

/** True when the given context is loaded (playing or paused). */
export function useIsContextActive(type: PlayContext["type"], id?: string): boolean {
  return usePlayer((s) => s.context?.type === type && s.context.id === id);
}

/** Plays the context, or toggles pause when it is already the active one. */
export function playOrToggle(context: PlayContext, load: () => Promise<Track[]> | Track[], startIndex = 0) {
  const player = usePlayer.getState();
  if (player.context?.type === context.type && player.context.id === context.id && player.current) {
    player.togglePlay();
    return;
  }
  void Promise.resolve(load()).then((tracks) => usePlayer.getState().playTracks(tracks, startIndex, context));
}

export const loaders = {
  album: (provider: MusicProvider, id: string) => () => provider.getAlbum(id).then((a) => a.tracks),
  playlist: (provider: MusicProvider, id: string) => () => provider.getPlaylist(id).then((p) => p.tracks),
  /** Artist radio-ish: top tracks if available, otherwise all album tracks of the artist. */
  artist: (provider: MusicProvider, id: string, name: string) => async () => {
    if (provider.capabilities.topTracks) {
      const top = await provider.getTopTracks({ id, name }, 20);
      if (top.length > 0) return top;
    }
    const artist = await provider.getArtist(id);
    const albums = await Promise.all(artist.albums.slice(0, 10).map((a) => provider.getAlbum(a.id)));
    return albums.flatMap((a) => a.tracks);
  },
  liked: (provider: MusicProvider) => () => provider.getStarred().then((s) => s.tracks),
};

/** Shuffle button: off → shuffle → Shuffle+ (with recommendations) → off. */
export async function cycleShuffle(provider: MusicProvider | null): Promise<void> {
  const player = usePlayer.getState();
  const nextMode = player.shuffle === "off" ? "shuffle" : player.shuffle === "shuffle" ? "smart" : "off";
  if (nextMode !== "smart") {
    player.setShuffle(nextMode);
    return;
  }
  if (!provider?.capabilities.similarTracks) {
    player.setShuffle("off");
    return;
  }
  const originals = player.contextItems.filter((i) => !i.recommended);
  const seeds = [...originals].sort(() => Math.random() - 0.5).slice(0, 3);
  const lists = await Promise.all(
    seeds.map((s) => provider.getSimilarTracks(s.track.id, 15).catch(() => [])),
  );
  usePlayer.getState().setShuffle("smart", lists.flat());
}

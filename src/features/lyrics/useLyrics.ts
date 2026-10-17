import { useQuery } from "@tanstack/react-query";
import type { Lyrics, MusicProvider, Track } from "@/api/provider";
import { useProvider } from "@/api/session";
import { useSettings } from "@/settings/store";
import { fetchLrclib } from "./lrclib";
import { readLocalLyrics } from "./localLyrics";

/** What the lookup found for one track. `lyrics: null` is a cached negative result. */
export interface ResolvedLyrics {
  lyrics: Lyrics | null;
  /** The track is known to be instrumental (nothing to find). */
  instrumental: boolean;
}

const hasLines = (lyrics: Lyrics | null | undefined): lyrics is Lyrics =>
  !!lyrics && lyrics.lines.some((line) => line.text.trim() !== "");

async function serverLyrics(provider: MusicProvider, track: Track): Promise<Lyrics | null> {
  if (!provider.capabilities.lyrics) return null;
  try {
    const lyrics = await provider.getLyrics(track);
    return hasLines(lyrics) ? lyrics : null;
  } catch {
    return null;
  }
}

/**
 * Lookup order: synced lyrics from the server, else synced lyrics from LRCLIB, else the best unsynced
 * text (server first, then LRCLIB).
 */
export async function resolveLyrics(
  provider: MusicProvider,
  track: Track,
  signal?: AbortSignal,
  { online = true }: { online?: boolean } = {},
): Promise<ResolvedLyrics> {
  const server = await serverLyrics(provider, track);
  if (server?.synced) return { lyrics: server, instrumental: false };
  if (!online) return { lyrics: server, instrumental: false };

  const lrclib = await fetchLrclib(track, signal);
  if (lrclib.lyrics?.synced) return { lyrics: lrclib.lyrics, instrumental: false };

  const unsynced = server ?? (hasLines(lrclib.lyrics) ? lrclib.lyrics : null);
  return { lyrics: unsynced, instrumental: !unsynced && lrclib.instrumental };
}

/**
 * Lyrics of a track (server first, LRCLIB as fallback), cached per server and track for the session.
 * `lyrics` is null when there are none; `source` tells where they came from.
 */
export function useLyrics(track: Track | undefined) {
  const provider = useProvider();
  const online = useSettings((s) => s.onlineLyrics);
  const query = useQuery({
    queryKey: [provider.server.id, "lyrics", track?.id, online],
    queryFn: async ({ signal }) => {
      // A .lrc next to a downloaded file comes first (works offline, and the user's own files win).
      const local = await readLocalLyrics(track!);
      if (local?.synced) return { lyrics: local, instrumental: false };
      const resolved = await resolveLyrics(provider, track!, signal, { online });
      if (local && (!resolved.lyrics || (!resolved.lyrics.synced && resolved.lyrics.source === "lrclib"))) {
        return { lyrics: local, instrumental: false };
      }
      return resolved;
    },
    enabled: !!track,
    staleTime: Infinity,
    retry: false,
  });
  const lyrics = query.data?.lyrics ?? null;
  return {
    lyrics,
    source: lyrics?.source ?? null,
    instrumental: query.data?.instrumental ?? false,
    isLoading: !!track && query.isPending,
  };
}

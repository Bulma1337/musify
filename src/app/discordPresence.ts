import type { Track } from "@/api/provider";
import { httpRequest } from "@/api/http";
import i18n from "@/i18n";
import { inTauri } from "@/lib/platform";
import { usePlayer, type PlayerState } from "@/player/store";
import { useSettings } from "@/settings/store";
import { registerShutdownTask } from "./windowClose";

/**
 * Discord Rich Presence: title, artists, a public cover and the progress bar of the playing track.
 * Updates go out on track changes, play/pause and seeks (not on every position tick); the native
 * side limits the rate and reconnects when Discord starts later.
 */

interface PresenceInput {
  title: string;
  artists: string;
  album: string | null;
  coverUrl: string | null;
  durationMs: number | null;
  positionMs: number;
  playing: boolean;
  pausedLabel: string;
}

/** Album art from public music searches (Deezer, then Apple), keyed by artist + album. */
const covers = new Map<string, Promise<string | null>>();

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * A public image URL for the album. The music server's own cover URL is never sent: it carries
 * the login. Only artist and album name go to the search.
 */
export function publicCoverUrl(track: Track): Promise<string | null> {
  const artist = track.artists[0]?.name;
  const album = track.album?.name;
  if (!artist || !album) return Promise.resolve(null);
  const key = `${normalize(artist)}|${normalize(album)}`;
  let found = covers.get(key);
  if (!found) {
    found = lookupCover(artist, album).catch(() => null);
    covers.set(key, found);
  }
  return found;
}

/** The entry whose title is the album ("The Singles 86>98" matches "The Singles 86-98"). */
function bestMatch<T>(items: T[] | undefined, title: (item: T) => string | undefined, album: string) {
  const wanted = normalize(album);
  return (
    items?.find((item) => normalize(title(item) ?? "") === wanted) ??
    items?.find((item) => normalize(title(item) ?? "").startsWith(wanted))
  );
}

/** Deezer has the widest catalog (also German rap and indie releases Apple lacks). */
async function deezerCover(artist: string, album: string): Promise<string | null> {
  const q = encodeURIComponent(`artist:"${artist}" album:"${album}"`);
  const response = await httpRequest(`https://api.deezer.com/search/album?q=${q}&limit=10`, {
    timeoutMs: 6000,
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { data?: { title?: string; cover_xl?: string }[] };
  return bestMatch(data.data, (a) => a.title, album)?.cover_xl ?? null;
}

async function appleCover(artist: string, album: string): Promise<string | null> {
  const term = encodeURIComponent(`${artist} ${album}`);
  const response = await httpRequest(
    `https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=10`,
    { timeoutMs: 6000 },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as {
    results?: { collectionName?: string; artworkUrl100?: string }[];
  };
  const match = bestMatch(data.results, (r) => r.collectionName, album);
  return match?.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/512x512bb.") ?? null;
}

async function lookupCover(artist: string, album: string): Promise<string | null> {
  for (const source of [deezerCover, appleCover]) {
    const url = await source(artist, album).catch(() => null);
    if (url) return url;
  }
  return null;
}

async function presenceOf(s: PlayerState): Promise<PresenceInput | null> {
  const track = s.current?.track;
  if (!track) return null;
  const coverUrl = useSettings.getState().discordCovers ? await publicCoverUrl(track) : null;
  return {
    title: track.title,
    artists: track.artistLine,
    album: track.album?.name ?? null,
    coverUrl,
    durationMs: s.durationMs || track.durationMs || null,
    positionMs: s.positionMs,
    playing: s.isPlaying,
    pausedLabel: i18n.t("player.pausedState"),
  };
}

async function send(presence: PresenceInput | null) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("discord_presence", { presence }).catch(() => {});
}

export function startDiscordPresence(): () => void {
  if (!inTauri) return () => {};
  let version = 0;
  const update = (s: PlayerState) => {
    const mine = ++version;
    if (!useSettings.getState().discordPresence) {
      void send(null);
      return;
    }
    void presenceOf(s).then((presence) => {
      // A newer state arrived while the cover was looked up.
      if (mine === version) void send(presence);
    });
  };

  update(usePlayer.getState());
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (
      s.current?.key !== prev.current?.key ||
      s.isPlaying !== prev.isPlaying ||
      s.seekNonce !== prev.seekNonce ||
      s.startNonce !== prev.startNonce ||
      (s.durationMs !== prev.durationMs && prev.durationMs === 0)
    ) {
      update(s);
    }
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.discordPresence !== prev.discordPresence || s.discordCovers !== prev.discordCovers) {
      update(usePlayer.getState());
    }
  });
  const offShutdown = registerShutdownTask(() => send(null));
  return () => {
    offPlayer();
    offSettings();
    offShutdown();
    void send(null);
  };
}

import type { Track } from "@/api/provider";
import { httpRequest } from "@/api/http";
import { useSession } from "@/api/session";
import i18n from "@/i18n";
import { inTauri } from "@/lib/platform";
import { usePlayer, type PlayerState } from "@/player/store";
import { useSettings } from "@/settings/store";
import { imageSignature, pickClosest, type CoverCandidate, type Signature } from "./coverMatch";
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

/** Album art from public music searches (Deezer and Apple), keyed by artist + album. */
const covers = new Map<string, Promise<string | null>>();

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Up to this many editions per source are compared with the own cover. */
const MAX_CANDIDATES = 4;

export interface CoverLookup {
  /** Signature of the cover on the music server; only used here, never sent anywhere. */
  ownSignature?: () => Promise<Signature | null>;
  /** Loads a public image's signature (tests replace it). */
  loadSignature?: (url: string) => Promise<Signature | null>;
}

/**
 * A public image URL for the album, the one that looks most like the cover on the music server.
 * The server's own cover URL is never sent: it carries the login. Only artist and album name go
 * to the searches.
 */
export function publicCoverUrl(track: Track, lookup: CoverLookup = {}): Promise<string | null> {
  const artist = track.artists[0]?.name;
  const album = track.album?.name;
  if (!artist || !album) return Promise.resolve(null);
  const key = `${normalize(artist)}|${normalize(album)}`;
  let found = covers.get(key);
  if (!found) {
    found = lookupCover(artist, album, lookup).catch(() => null);
    covers.set(key, found);
  }
  return found;
}

/** Entries whose title is the album ("The Singles 86>98" matches "The Singles 86-98"), exact first. */
function matching<T>(items: T[] | undefined, title: (item: T) => string | undefined, album: string): T[] {
  const wanted = normalize(album);
  const exact = (items ?? []).filter((item) => normalize(title(item) ?? "") === wanted);
  const prefixed = (items ?? []).filter((item) => {
    const t = normalize(title(item) ?? "");
    return t !== wanted && t.startsWith(wanted);
  });
  return [...exact, ...prefixed].slice(0, MAX_CANDIDATES);
}

/** Deezer has the widest catalog (also German rap and indie releases Apple lacks). */
async function deezerCovers(artist: string, album: string): Promise<CoverCandidate[]> {
  const q = encodeURIComponent(`artist:"${artist}" album:"${album}"`);
  const response = await httpRequest(`https://api.deezer.com/search/album?q=${q}&limit=10`, {
    timeoutMs: 6000,
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    data?: { title?: string; cover_small?: string; cover_xl?: string }[];
  };
  return matching(data.data, (a) => a.title, album).flatMap((a) =>
    a.cover_xl ? [{ compareUrl: a.cover_small ?? a.cover_xl, displayUrl: a.cover_xl }] : [],
  );
}

async function appleCovers(artist: string, album: string): Promise<CoverCandidate[]> {
  const term = encodeURIComponent(`${artist} ${album}`);
  const response = await httpRequest(
    `https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=10`,
    { timeoutMs: 6000 },
  );
  if (!response.ok) return [];
  const data = (await response.json()) as {
    results?: { collectionName?: string; artworkUrl100?: string }[];
  };
  return matching(data.results, (r) => r.collectionName, album).flatMap((r) =>
    r.artworkUrl100
      ? [{ compareUrl: r.artworkUrl100, displayUrl: r.artworkUrl100.replace(/\/\d+x\d+bb\./, "/512x512bb.") }]
      : [],
  );
}

async function lookupCover(artist: string, album: string, lookup: CoverLookup): Promise<string | null> {
  const [deezer, apple] = await Promise.all([
    deezerCovers(artist, album).catch(() => []),
    appleCovers(artist, album).catch(() => []),
  ]);
  // Deezer first: with nothing to compare against, its best match wins.
  const candidates = [...deezer, ...apple];
  if (candidates.length <= 1) return candidates[0]?.displayUrl ?? null;
  const own = (await lookup.ownSignature?.().catch(() => null)) ?? null;
  return (await pickClosest(own, candidates, lookup.loadSignature))?.displayUrl ?? null;
}

/** The music server's cover of the track, as a signature for picking the closest public one. */
function ownCoverSignature(track: Track): () => Promise<Signature | null> {
  return async () => {
    const provider = useSession.getState().provider;
    if (!provider || !track.cover) return null;
    return imageSignature(provider.coverUrl(track.cover, 64));
  };
}

async function presenceOf(s: PlayerState): Promise<PresenceInput | null> {
  const track = s.current?.track;
  if (!track) return null;
  const coverUrl = useSettings.getState().discordCovers
    ? await publicCoverUrl(track, { ownSignature: ownCoverSignature(track) })
    : null;
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

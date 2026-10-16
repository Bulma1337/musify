import type {
  Album,
  AlbumDetail,
  Artist,
  ArtistDetail,
  ArtistRef,
  Lyrics,
  LyricLine,
  Playlist,
  PlaylistDetail,
  ReleaseType,
  Track,
} from "../provider";
import type {
  WireAlbum,
  WireArtist,
  WireChild,
  WireCueLine,
  WireItemArtist,
  WirePlaylist,
  WireStructuredLyrics,
} from "./wire";

const toMs = (seconds: number | undefined): number => Math.round((seconds ?? 0) * 1000);

function mapArtistRefs(list: WireItemArtist[] | undefined): ArtistRef[] {
  return (list ?? [])
    .filter((a) => a && a.name)
    .map((a) => (a.id ? { id: a.id, name: a.name } : { name: a.name }));
}

function artistRefsWithFallback(
  list: WireItemArtist[] | undefined,
  artistId: string | undefined,
  artist: string | undefined,
): ArtistRef[] {
  const refs = mapArtistRefs(list);
  if (refs.length > 0) return refs;
  if (!artist) return [];
  return [artistId ? { id: artistId, name: artist } : { name: artist }];
}

function mapGenres(genres: { name: string }[] | undefined, genre: string | undefined): string[] {
  const names = (genres ?? []).map((g) => g.name).filter(Boolean);
  if (names.length > 0) return names;
  return genre ? [genre] : [];
}

function joinNames(refs: ArtistRef[]): string {
  return refs.map((a) => a.name).join(", ");
}

export function mapTrack(serverId: string, c: WireChild): Track {
  const artists = artistRefsWithFallback(c.artists, c.artistId, c.artist);
  const rg = c.replayGain;
  const track: Track = {
    id: c.id,
    serverId,
    title: c.title ?? "",
    artists,
    artistLine: c.displayArtist || c.artist || joinNames(artists),
    albumArtists: mapArtistRefs(c.albumArtists),
    durationMs: toMs(c.duration),
    genres: mapGenres(c.genres, c.genre),
    format: {
      container: c.suffix,
      bitRate: c.bitRate,
      sampleRate: c.samplingRate,
      bitDepth: c.bitDepth,
      channels: c.channelCount,
      sizeBytes: c.size,
    },
    starred: Boolean(c.starred),
  };
  if (c.albumId) track.album = { id: c.albumId, name: c.album ?? "" };
  if (c.track !== undefined) track.trackNumber = c.track;
  if (c.discNumber !== undefined) track.discNumber = c.discNumber;
  if (c.year !== undefined) track.year = c.year;
  if (c.coverArt) track.cover = c.coverArt;
  if (rg && typeof rg === "object") {
    track.replayGain = {
      trackGain: rg.trackGain,
      albumGain: rg.albumGain,
      trackPeak: rg.trackPeak,
      albumPeak: rg.albumPeak,
    };
  }
  if (c.explicitStatus === "explicit") track.explicit = true;
  else if (c.explicitStatus === "clean") track.explicit = false;
  if (c.starred) track.starredAt = c.starred;
  if (c.playCount !== undefined) track.playCount = c.playCount;
  if (c.played) track.lastPlayedAt = c.played;
  if (c.userRating !== undefined && c.userRating > 0) track.rating = c.userRating;
  if (c.bpm !== undefined && c.bpm > 0) track.bpm = c.bpm;
  if (c.musicBrainzId) track.musicBrainzId = c.musicBrainzId;
  return track;
}

function mapReleaseType(a: WireAlbum): ReleaseType | undefined {
  if (a.isCompilation) return "compilation";
  const first = a.releaseTypes?.[0]?.toLowerCase();
  if (!first) return undefined;
  switch (first) {
    case "album":
    case "single":
    case "ep":
    case "compilation":
    case "live":
      return first;
    default:
      return "other";
  }
}

export function mapAlbum(serverId: string, a: WireAlbum): Album {
  const artists = artistRefsWithFallback(a.artists, a.artistId, a.artist);
  const album: Album = {
    id: a.id,
    serverId,
    name: a.name ?? a.title ?? "",
    artists,
    artistLine: a.displayArtist || a.artist || joinNames(artists),
    genres: mapGenres(a.genres, a.genre),
    trackCount: a.songCount ?? a.song?.length ?? 0,
    durationMs: toMs(a.duration),
    starred: Boolean(a.starred),
  };
  if (a.year !== undefined) album.year = a.year;
  if (a.coverArt) album.cover = a.coverArt;
  if (a.created) album.addedAt = a.created;
  if (a.starred) album.starredAt = a.starred;
  if (a.playCount !== undefined) album.playCount = a.playCount;
  if (a.played) album.lastPlayedAt = a.played;
  const releaseType = mapReleaseType(a);
  if (releaseType) album.releaseType = releaseType;
  return album;
}

export function mapAlbumDetail(serverId: string, a: WireAlbum): AlbumDetail {
  const detail: AlbumDetail = {
    ...mapAlbum(serverId, a),
    tracks: (a.song ?? []).map((s) => mapTrack(serverId, s)),
  };
  if (a.discTitles && a.discTitles.length > 0) {
    const titles: Record<number, string> = {};
    for (const d of a.discTitles) {
      const title = d.title ?? d.name;
      if (title) titles[d.disc] = title;
    }
    if (Object.keys(titles).length > 0) detail.discTitles = titles;
  }
  return detail;
}

export function mapArtist(serverId: string, a: WireArtist): Artist {
  const artist: Artist = { id: a.id, serverId, name: a.name ?? "", starred: Boolean(a.starred) };
  if (a.coverArt) artist.cover = a.coverArt;
  if (a.albumCount !== undefined) artist.albumCount = a.albumCount;
  if (a.starred) artist.starredAt = a.starred;
  return artist;
}

export function mapArtistDetail(serverId: string, a: WireArtist): ArtistDetail {
  const albums = (a.album ?? []).map((x) => mapAlbum(serverId, x));
  // Newest first; albums without a year go last. Array.prototype.sort is stable.
  albums.sort((x, y) => (y.year ?? -1) - (x.year ?? -1));
  return { ...mapArtist(serverId, a), albums };
}

function mapPlaylistBase(serverId: string, p: WirePlaylist, username: string): Playlist {
  const playlist: Playlist = {
    id: p.id,
    serverId,
    name: p.name ?? "",
    public: Boolean(p.public),
    trackCount: p.songCount ?? p.entry?.length ?? 0,
    durationMs: toMs(p.duration),
    readOnly: p.readonly !== undefined ? p.readonly : p.owner !== undefined && p.owner !== username,
  };
  if (p.comment) playlist.comment = p.comment;
  if (p.owner) playlist.owner = p.owner;
  if (p.coverArt) playlist.cover = p.coverArt;
  if (p.created) playlist.createdAt = p.created;
  if (p.changed) playlist.changedAt = p.changed;
  return playlist;
}

export function mapPlaylist(serverId: string, p: WirePlaylist, username: string): Playlist {
  return mapPlaylistBase(serverId, p, username);
}

export function mapPlaylistDetail(serverId: string, p: WirePlaylist, username: string): PlaylistDetail {
  return {
    ...mapPlaylistBase(serverId, p, username),
    tracks: (p.entry ?? []).map((e) => mapTrack(serverId, e)),
  };
}

// --- Lyrics ------------------------------------------------------------------------------------

function mapCues(cues: WireCueLine[] | undefined): LyricLine["words"] {
  if (!cues || cues.length === 0) return undefined;
  return cues.map((c) =>
    c.end !== undefined
      ? { startMs: c.start, endMs: c.end, text: c.value }
      : { startMs: c.start, text: c.value },
  );
}

/** Maps the preferred entry of `getLyricsBySongId` (first synced, else first); null if it has no lines. */
export function mapStructuredLyrics(list: WireStructuredLyrics[] | undefined): Lyrics | null {
  if (!list || list.length === 0) return null;
  const entry = list.find((l) => l.synced) ?? list[0];
  if (!entry) return null;
  const rawLines = entry.line ?? [];
  if (rawLines.length === 0) return null;

  const synced = Boolean(entry.synced);
  const topLevelCues = new Map<number, WireCueLine[]>();
  for (const cue of entry.cueLine ?? []) {
    if (cue.index === undefined) continue;
    const bucket = topLevelCues.get(cue.index) ?? [];
    bucket.push(cue);
    topLevelCues.set(cue.index, bucket);
  }

  const lines: LyricLine[] = rawLines.map((l, index) => {
    const text = (l.value ?? "").trim() === "" ? "" : (l.value ?? "");
    const line: LyricLine = { text };
    if (synced && l.start !== undefined) line.startMs = l.start;
    const words = mapCues(l.cueLine ?? topLevelCues.get(index));
    if (words) line.words = words;
    return line;
  });

  const lyrics: Lyrics = { synced, lines, offsetMs: entry.offset ?? 0, source: "server" };
  if (entry.lang && entry.lang !== "xxx") lyrics.language = entry.lang;
  return lyrics;
}

/** Maps the legacy `getLyrics` plain text; null if blank. */
export function mapLegacyLyrics(value: string | undefined): Lyrics | null {
  if (!value) return null;
  const lines = value.split(/\r?\n/).map((l) => (l.trim() === "" ? "" : l));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  return { synced: false, lines: lines.map((text) => ({ text })), offsetMs: 0, source: "server" };
}

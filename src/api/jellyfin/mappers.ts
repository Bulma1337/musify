import type {
  Album,
  AlbumDetail,
  Artist,
  ArtistDetail,
  ArtistRef,
  AudioFormat,
  CoverRef,
  LyricLine,
  LyricWord,
  Lyrics,
  Playlist,
  PlaylistDetail,
  ReplayGain,
  Track,
} from "../provider";
import type { WireItem, WireLyricDto, WireLyricLine, WireMediaSource, WireNameId } from "./wire";

/** Jellyfin time unit: 1 tick = 100 ns, i.e. 10 000 ticks per millisecond. */
const TICKS_PER_MS = 10_000;

export const ticksToMs = (ticks: number | null | undefined): number =>
  Math.round((ticks ?? 0) / TICKS_PER_MS);
export const msToTicks = (ms: number): number => Math.round(Math.max(0, ms) * TICKS_PER_MS);

// --- Cover references ------------------------------------------------------------------------------

/** A cover ref is `<itemId>` or `<itemId>:<imageTag>`; the tag only serves HTTP cache busting. */
export function makeCover(itemId: string, tag?: string | null): CoverRef {
  return tag ? `${itemId}:${tag}` : itemId;
}

export function parseCover(cover: CoverRef): { id: string; tag?: string } {
  const at = cover.indexOf(":");
  if (at < 0) return { id: cover };
  const tag = cover.slice(at + 1);
  return tag ? { id: cover.slice(0, at), tag } : { id: cover.slice(0, at) };
}

function ownCover(item: WireItem): CoverRef | undefined {
  const tag = item.ImageTags?.Primary;
  return tag ? makeCover(item.Id, tag) : undefined;
}

/** The item's own image if it has one, else its album's. */
function trackCover(item: WireItem): CoverRef | undefined {
  const own = ownCover(item);
  if (own) return own;
  if (item.AlbumId && item.AlbumPrimaryImageTag) return makeCover(item.AlbumId, item.AlbumPrimaryImageTag);
  return undefined;
}

// --- Shared pieces ---------------------------------------------------------------------------------

function refsFromItems(list: WireNameId[] | null | undefined): ArtistRef[] {
  return (list ?? [])
    .filter((a) => a.Name)
    .map((a) => (a.Id ? { id: a.Id, name: a.Name as string } : { name: a.Name as string }));
}

function artistRefs(items: WireNameId[] | null | undefined, names: string[] | null | undefined): ArtistRef[] {
  const refs = refsFromItems(items);
  if (refs.length > 0) return refs;
  return (names ?? []).filter(Boolean).map((name) => ({ name }));
}

const joinNames = (refs: ArtistRef[]): string => refs.map((a) => a.name).join(", ");

const KNOWN_CONTAINERS = [
  "flac",
  "mp3",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "aiff",
  "wma",
  "ape",
  "wv",
  "dsf",
  "mka",
];

/** Jellyfin reports ffmpeg format lists such as "mov,mp4,m4a,3gp,3g2,mj2"; pick the audio suffix. */
export function normalizeContainer(container: string | null | undefined): string | undefined {
  if (!container) return undefined;
  const parts = container
    .toLowerCase()
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts[0];
  return KNOWN_CONTAINERS.find((c) => parts.includes(c)) ?? parts[0];
}

function mapFormat(item: WireItem): AudioFormat {
  const source: WireMediaSource | undefined = item.MediaSources?.[0];
  const stream = source?.MediaStreams?.find((s) => s.Type === "Audio");
  const format: AudioFormat = {};
  const container = normalizeContainer(source?.Container ?? item.Container);
  if (container) format.container = container;
  if (stream?.Codec) format.codec = stream.Codec.toLowerCase();
  const bitsPerSecond = stream?.BitRate ?? source?.Bitrate;
  if (bitsPerSecond) format.bitRate = Math.round(bitsPerSecond / 1000);
  if (stream?.SampleRate) format.sampleRate = stream.SampleRate;
  if (stream?.BitDepth) format.bitDepth = stream.BitDepth;
  if (stream?.Channels) format.channels = stream.Channels;
  if (source?.Size) format.sizeBytes = source.Size;
  return format;
}

function mapReplayGain(item: WireItem): ReplayGain | undefined {
  const gain: ReplayGain = {};
  if (typeof item.NormalizationGain === "number") gain.trackGain = item.NormalizationGain;
  if (typeof item.AlbumNormalizationGain === "number") gain.albumGain = item.AlbumNormalizationGain;
  return gain.trackGain !== undefined || gain.albumGain !== undefined ? gain : undefined;
}

// --- Items -----------------------------------------------------------------------------------------

export function mapTrack(serverId: string, item: WireItem): Track {
  const artists = artistRefs(item.ArtistItems, item.Artists);
  const albumArtists = artistRefs(item.AlbumArtists, item.AlbumArtist ? [item.AlbumArtist] : []);
  const track: Track = {
    id: item.Id,
    serverId,
    title: item.Name ?? "",
    artists,
    artistLine: joinNames(artists),
    albumArtists,
    durationMs: ticksToMs(item.RunTimeTicks),
    genres: item.Genres ?? [],
    format: mapFormat(item),
    starred: Boolean(item.UserData?.IsFavorite),
  };
  if (item.AlbumId) track.album = { id: item.AlbumId, name: item.Album ?? "" };
  if (item.IndexNumber != null) track.trackNumber = item.IndexNumber;
  if (item.ParentIndexNumber != null) track.discNumber = item.ParentIndexNumber;
  if (item.ProductionYear) track.year = item.ProductionYear;
  const cover = trackCover(item);
  if (cover) track.cover = cover;
  const replayGain = mapReplayGain(item);
  if (replayGain) track.replayGain = replayGain;
  const userData = item.UserData;
  if (userData?.PlayCount !== undefined) track.playCount = userData.PlayCount;
  if (userData?.LastPlayedDate) track.lastPlayedAt = userData.LastPlayedDate;
  const mbid = item.ProviderIds?.MusicBrainzRecording ?? item.ProviderIds?.MusicBrainzTrack;
  if (mbid) track.musicBrainzId = mbid;
  if (item.PlaylistItemId) track.playlistEntryId = item.PlaylistItemId;
  return track;
}

export function mapAlbum(serverId: string, item: WireItem): Album {
  const artists = artistRefs(item.AlbumArtists?.length ? item.AlbumArtists : item.ArtistItems, [
    ...(item.AlbumArtist ? [item.AlbumArtist] : []),
  ]);
  const album: Album = {
    id: item.Id,
    serverId,
    name: item.Name ?? "",
    artists,
    artistLine: item.AlbumArtist || joinNames(artists),
    genres: item.Genres ?? [],
    trackCount: item.ChildCount ?? item.SongCount ?? 0,
    durationMs: ticksToMs(item.RunTimeTicks),
    starred: Boolean(item.UserData?.IsFavorite),
  };
  if (item.ProductionYear) album.year = item.ProductionYear;
  const cover = ownCover(item);
  if (cover) album.cover = cover;
  if (item.DateCreated) album.addedAt = item.DateCreated;
  if (item.UserData?.PlayCount) album.playCount = item.UserData.PlayCount;
  if (item.UserData?.LastPlayedDate) album.lastPlayedAt = item.UserData.LastPlayedDate;
  return album;
}

export function mapAlbumDetail(serverId: string, item: WireItem, tracks: WireItem[]): AlbumDetail {
  const mapped = tracks.map((t) => mapTrack(serverId, t));
  const detail: AlbumDetail = { ...mapAlbum(serverId, item), tracks: mapped };
  // Albums often lack ChildCount/RunTimeTicks in listings; the tracks are authoritative here.
  if (detail.trackCount === 0) detail.trackCount = mapped.length;
  if (detail.durationMs === 0) detail.durationMs = mapped.reduce((sum, t) => sum + t.durationMs, 0);
  return detail;
}

export function mapArtist(serverId: string, item: WireItem): Artist {
  const artist: Artist = {
    id: item.Id,
    serverId,
    name: item.Name ?? "",
    starred: Boolean(item.UserData?.IsFavorite),
  };
  const cover = ownCover(item);
  if (cover) artist.cover = cover;
  if (item.AlbumCount != null) artist.albumCount = item.AlbumCount;
  return artist;
}

export function mapArtistDetail(serverId: string, item: WireItem, albums: WireItem[]): ArtistDetail {
  const mapped = albums.map((a) => mapAlbum(serverId, a));
  // Newest first; albums without a year go last. Array.prototype.sort is stable.
  mapped.sort((x, y) => (y.year ?? -1) - (x.year ?? -1));
  const artist = mapArtist(serverId, item);
  if (artist.albumCount === undefined) artist.albumCount = mapped.length;
  return { ...artist, albums: mapped };
}

export function mapPlaylist(
  serverId: string,
  item: WireItem,
  extra: { public?: boolean; readOnly?: boolean; trackCount?: number } = {},
): Playlist {
  const playlist: Playlist = {
    id: item.Id,
    serverId,
    name: item.Name ?? "",
    public: extra.public ?? false,
    trackCount: extra.trackCount ?? item.ChildCount ?? 0,
    durationMs: ticksToMs(item.RunTimeTicks),
    readOnly: extra.readOnly ?? item.CanDelete === false,
  };
  if (item.Overview) playlist.comment = item.Overview;
  const cover = ownCover(item);
  if (cover) playlist.cover = cover;
  if (item.DateCreated) playlist.createdAt = item.DateCreated;
  return playlist;
}

export function mapPlaylistDetail(
  serverId: string,
  item: WireItem,
  tracks: WireItem[],
  extra: { public?: boolean; readOnly?: boolean } = {},
): PlaylistDetail {
  const mapped = tracks.map((t) => mapTrack(serverId, t));
  const playlist = mapPlaylist(serverId, item, { ...extra, trackCount: mapped.length });
  if (playlist.durationMs === 0) playlist.durationMs = mapped.reduce((sum, t) => sum + t.durationMs, 0);
  return { ...playlist, tracks: mapped };
}

// --- Lyrics ----------------------------------------------------------------------------------------

function mapWords(line: WireLyricLine): LyricWord[] | undefined {
  const text = line.Text ?? "";
  const cues = (line.Cues ?? []).filter((c) => c.Start !== undefined && c.Start !== null);
  if (cues.length === 0) return undefined;
  const words: LyricWord[] = [];
  cues.forEach((cue, index) => {
    const from = Math.max(0, cue.Position ?? 0);
    const next = cues[index + 1]?.Position;
    const to = cue.EndPosition !== undefined && cue.EndPosition > from ? cue.EndPosition : next;
    const word = text.slice(from, to);
    if (word === "") return;
    words.push(
      cue.End != null
        ? { startMs: ticksToMs(cue.Start), endMs: ticksToMs(cue.End), text: word }
        : { startMs: ticksToMs(cue.Start), text: word },
    );
  });
  return words.length > 0 ? words : undefined;
}

/** Maps `GET /Audio/{id}/Lyrics`; null if the track has no lyric lines. */
export function mapLyrics(dto: WireLyricDto | null | undefined): Lyrics | null {
  const raw = dto?.Lyrics ?? [];
  if (raw.length === 0) return null;
  const synced = raw.some((l) => l.Start !== undefined && l.Start !== null);
  const lines: LyricLine[] = raw.map((l) => {
    const line: LyricLine = { text: (l.Text ?? "").trim() === "" ? "" : (l.Text ?? "") };
    if (synced && l.Start !== undefined && l.Start !== null) line.startMs = ticksToMs(l.Start);
    if (synced) {
      const words = mapWords(l);
      if (words) line.words = words;
    }
    return line;
  });
  return {
    synced,
    lines,
    // The offset is stored in ticks like every other Jellyfin time value.
    offsetMs: synced ? ticksToMs(dto?.Metadata?.Offset) : 0,
    source: "server",
  };
}

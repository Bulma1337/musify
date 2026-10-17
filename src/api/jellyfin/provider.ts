import {
  ProviderError,
  type Album,
  type AlbumDetail,
  type AlbumListOptions,
  type AlbumListType,
  type Artist,
  type ArtistDetail,
  type ArtistInfo,
  type ArtistRef,
  type Capabilities,
  type CoverRef,
  type Genre,
  type Lyrics,
  type MusicProvider,
  type PageOptions,
  type PlaybackEvent,
  type Playlist,
  type PlaylistDetail,
  type SearchResult,
  type ServerConfig,
  type StarrableKind,
  type StreamQuality,
  type StreamSource,
  type Track,
} from "../provider";
import type { JellyfinClient, Params } from "./client";
import {
  mapAlbum,
  mapAlbumDetail,
  mapArtist,
  mapArtistDetail,
  mapLyrics,
  mapPlaylist,
  mapPlaylistDetail,
  mapTrack,
  msToTicks,
  parseCover,
} from "./mappers";
import type { WireItem, WireLyricDto, WirePlaylistDto, WireQueryResult } from "./wire";

/** `Fields` requested for tracks: everything the track model needs that is not in the default DTO. */
const TRACK_FIELDS = ["Genres", "DateCreated", "MediaSources", "ParentId", "ProviderIds"];
const ALBUM_FIELDS = ["Genres", "DateCreated", "ChildCount", "ProviderIds"];

/** Ids per request for list parameters (keeps URLs short: a Jellyfin id is 32 characters). */
const ID_CHUNK = 100;
/** Played tracks examined to derive "recently/most played" albums (Jellyfin keeps no album-level counts). */
const PLAYED_SCAN_LIMIT = 500;
const MAX_PAGE = 500;

type ItemSort = { sortBy: string[]; sortOrder: "Ascending" | "Descending" };

const ALBUM_SORTS: Partial<Record<AlbumListType, ItemSort>> = {
  recentlyAdded: { sortBy: ["DateCreated", "SortName"], sortOrder: "Descending" },
  random: { sortBy: ["Random"], sortOrder: "Ascending" },
  alphabeticalByName: { sortBy: ["SortName"], sortOrder: "Ascending" },
  alphabeticalByArtist: { sortBy: ["AlbumArtist", "SortName"], sortOrder: "Ascending" },
  highestRated: { sortBy: ["CommunityRating", "SortName"], sortOrder: "Descending" },
  starred: { sortBy: ["SortName"], sortOrder: "Ascending" },
};

/** Codec / container pairs for transcodes (`/Audio/{id}/universal`). */
const TRANSCODE_FORMATS: Record<string, { codec: string; container: string }> = {
  mp3: { codec: "mp3", container: "mp3" },
  opus: { codec: "opus", container: "ogg" },
  ogg: { codec: "vorbis", container: "ogg" },
  vorbis: { codec: "vorbis", container: "ogg" },
  aac: { codec: "aac", container: "aac" },
  m4a: { codec: "aac", container: "mp4" },
  flac: { codec: "flac", container: "flac" },
};

function transcodeFormat(requested: string | undefined): { name: string; codec: string; container: string } {
  const name = (requested ?? "mp3").toLowerCase();
  const known = TRANSCODE_FORMATS[name];
  if (known) return { name, ...known };
  return /^[a-z0-9]{1,10}$/.test(name)
    ? { name, codec: name, container: name }
    : { name: "mp3", ...TRANSCODE_FORMATS.mp3! };
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Years covered by an inclusive range (`Years` is a list parameter). Capped at 200 years. */
function yearList(from: number | undefined, to: number | undefined): number[] | undefined {
  if (from === undefined && to === undefined) return undefined;
  const a = from ?? to ?? 0;
  const b = to ?? from ?? 0;
  const low = Math.min(a, b);
  const high = Math.min(Math.max(a, b), low + 200);
  const years: number[] = [];
  for (let y = low; y <= high; y++) years.push(y);
  return years;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
  const tails: number[] = []; // index into values of the smallest tail for each length
  const previous: number[] = new Array<number>(values.length).fill(-1);
  values.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = previous[i]!) keep.add(i);
  return keep;
}

export interface PlaylistMove {
  entryId: string;
  /** Position of the entry after the move (Jellyfin: "NewIndex"). */
  newIndex: number;
}

/**
 * Computes the fewest `Move` calls that turn the `current` entry order into `target`: entries that are
 * already in the right relative order (a longest increasing subsequence) stay, every other entry is
 * moved right behind its predecessor in the target. Both lists must hold the same unique ids.
 */
export function planPlaylistMoves(current: readonly string[], target: readonly string[]): PlaylistMove[] {
  const position = new Map(current.map((id, index) => [id, index]));
  const keep = longestIncreasingSubsequence(target.map((id) => position.get(id) ?? -1));
  const work = [...current];
  const moves: PlaylistMove[] = [];
  target.forEach((entryId, index) => {
    if (keep.has(index)) return;
    work.splice(work.indexOf(entryId), 1);
    const newIndex = index === 0 ? 0 : work.indexOf(target[index - 1]!) + 1;
    work.splice(newIndex, 0, entryId);
    moves.push({ entryId, newIndex });
  });
  return moves;
}

export class JellyfinProvider implements MusicProvider {
  constructor(
    private readonly client: JellyfinClient,
    readonly capabilities: Capabilities,
  ) {}

  get server(): ServerConfig {
    return this.client.server;
  }

  private get sid(): string {
    return this.client.server.id;
  }

  private get userId(): string {
    return this.client.userId;
  }

  private path(prefix: string, id: string, suffix = ""): string {
    return `${prefix}/${encodeURIComponent(id)}${suffix}`;
  }

  /** `GET /Items` with the common query defaults (current user, recursive, no total count). */
  private async items(params: Params): Promise<WireItem[]> {
    const res = await this.client.getJson<WireQueryResult>("/Items", {
      userId: this.userId,
      recursive: true,
      enableTotalRecordCount: false,
      ...params,
    });
    return res.Items ?? [];
  }

  private async tracksQuery(params: Params): Promise<Track[]> {
    const items = await this.items({ includeItemTypes: "Audio", fields: TRACK_FIELDS, ...params });
    return items.map((i) => mapTrack(this.sid, i));
  }

  private getItem(id: string): Promise<WireItem> {
    return this.client.getJson<WireItem>(this.path("/Items", id), { userId: this.userId });
  }

  async ping(): Promise<void> {
    await this.client.request("GET", "/Users/Me");
  }

  // --- Browsing ----------------------------------------------------------------------------------

  async getAlbumList(type: AlbumListType, options: AlbumListOptions = {}): Promise<Album[]> {
    const limit = Math.min(Math.max(options.size ?? 50, 1), MAX_PAGE);
    const offset = options.offset ?? 0;
    if (type === "recentlyPlayed" || type === "mostPlayed") return this.albumsFromPlays(type, limit, offset);

    const params: Params = {
      includeItemTypes: "MusicAlbum",
      fields: ALBUM_FIELDS,
      limit,
      startIndex: offset,
    };
    const sort = ALBUM_SORTS[type];
    if (type === "starred") params.isFavorite = true;
    if (type === "byGenre") {
      params.genres = options.genre;
      Object.assign(params, { sortBy: ["SortName"], sortOrder: "Ascending" });
    }
    if (type === "byYear") {
      params.years = yearList(options.fromYear, options.toYear);
      const descending = (options.fromYear ?? 0) > (options.toYear ?? Number.MAX_SAFE_INTEGER);
      Object.assign(params, {
        sortBy: ["ProductionYear", "SortName"],
        sortOrder: descending ? "Descending" : "Ascending",
      });
    }
    if (sort) Object.assign(params, sort);
    return (await this.items(params)).map((a) => mapAlbum(this.sid, a));
  }

  /**
   * Jellyfin stores play data per track only (album items always report 0 plays), so these lists are
   * derived from the played tracks: grouped by album, ordered by last play or by summed play count.
   */
  private async albumsFromPlays(
    type: "recentlyPlayed" | "mostPlayed",
    limit: number,
    offset: number,
  ): Promise<Album[]> {
    const tracks = await this.items({
      includeItemTypes: "Audio",
      filters: "IsPlayed",
      sortBy: [type === "recentlyPlayed" ? "DatePlayed" : "PlayCount"],
      sortOrder: "Descending",
      limit: PLAYED_SCAN_LIMIT,
    });
    const score = new Map<string, number>(); // insertion order = order of first (most recent) play
    for (const track of tracks) {
      if (!track.AlbumId) continue;
      score.set(track.AlbumId, (score.get(track.AlbumId) ?? 0) + (track.UserData?.PlayCount ?? 1));
    }
    let ids = [...score.keys()];
    if (type === "mostPlayed") ids = ids.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
    ids = ids.slice(offset, offset + limit);
    if (ids.length === 0) return [];
    const albums = await this.items({ ids, includeItemTypes: "MusicAlbum", fields: ALBUM_FIELDS });
    const order = new Map(ids.map((id, index) => [id, index]));
    return albums
      .sort((a, b) => (order.get(a.Id) ?? 0) - (order.get(b.Id) ?? 0))
      .map((a) => mapAlbum(this.sid, a));
  }

  async getAlbum(id: string): Promise<AlbumDetail> {
    const [item, tracks] = await Promise.all([
      this.getItem(id),
      this.items({
        parentId: id,
        includeItemTypes: "Audio",
        fields: TRACK_FIELDS,
        sortBy: ["ParentIndexNumber", "IndexNumber", "SortName"],
        sortOrder: "Ascending",
      }),
    ]);
    return mapAlbumDetail(this.sid, item, tracks);
  }

  async getArtists(): Promise<Artist[]> {
    const pageSize = 1000;
    const artists: Artist[] = [];
    for (let start = 0; ; start += pageSize) {
      const res = await this.client.getJson<WireQueryResult>("/Artists/AlbumArtists", {
        userId: this.userId,
        fields: ["ItemCounts"],
        sortBy: ["SortName"],
        sortOrder: "Ascending",
        startIndex: start,
        limit: pageSize,
      });
      const items = res.Items ?? [];
      artists.push(...items.map((a) => mapArtist(this.sid, a)));
      if (items.length < pageSize || start + items.length >= (res.TotalRecordCount ?? 0)) break;
    }
    return artists;
  }

  async getArtist(id: string): Promise<ArtistDetail> {
    const [item, albums] = await Promise.all([
      this.getItem(id),
      this.items({ includeItemTypes: "MusicAlbum", albumArtistIds: id, fields: ALBUM_FIELDS }),
    ]);
    return mapArtistDetail(this.sid, item, albums);
  }

  async getArtistInfo(id: string): Promise<ArtistInfo | null> {
    const [item, similar] = await Promise.all([
      this.getItem(id),
      this.client
        .getJson<WireQueryResult>(this.path("/Artists", id, "/Similar"), { userId: this.userId, limit: 20 })
        .catch((error: unknown) => {
          if (error instanceof ProviderError && error.kind === "notFound")
            return { Items: [] } as WireQueryResult;
          throw error;
        }),
    ]);
    const result: ArtistInfo = { similarArtists: (similar.Items ?? []).map((a) => mapArtist(this.sid, a)) };
    if (item.Overview?.trim()) result.biography = item.Overview;
    const imageTag = item.ImageTags?.Primary;
    if (imageTag) {
      result.imageUrl = this.client.url(this.path("/Items", item.Id, "/Images/Primary"), {
        maxWidth: 1200,
        quality: 90,
        tag: imageTag,
      });
    }
    const externalUrl = item.ExternalUrls?.find((u) => u.Url)?.Url;
    if (externalUrl) result.externalUrl = externalUrl;
    if (!result.biography && !result.imageUrl && !result.externalUrl && result.similarArtists.length === 0) {
      return null;
    }
    return result;
  }

  private async resolveArtistId(artist: ArtistRef): Promise<string | undefined> {
    if (artist.id) return artist.id;
    const res = await this.client.getJson<WireQueryResult>("/Artists", {
      userId: this.userId,
      searchTerm: artist.name,
      limit: 10,
      enableTotalRecordCount: false,
    });
    const wanted = artist.name.toLowerCase();
    return (res.Items ?? []).find((a) => a.Name?.toLowerCase() === wanted)?.Id;
  }

  async getTopTracks(artist: ArtistRef, count = 20): Promise<Track[]> {
    const artistId = await this.resolveArtistId(artist);
    if (!artistId) return [];
    return this.tracksQuery({
      artistIds: artistId,
      sortBy: ["PlayCount", "SortName"],
      sortOrder: "Descending",
      limit: count,
    });
  }

  async getSimilarTracks(trackId: string, count = 30): Promise<Track[]> {
    const res = await this.client.getJson<WireQueryResult>(this.path("/Items", trackId, "/InstantMix"), {
      userId: this.userId,
      limit: count + 1,
      fields: TRACK_FIELDS,
    });
    return (res.Items ?? [])
      .filter((i) => i.Id !== trackId)
      .slice(0, count)
      .map((i) => mapTrack(this.sid, i));
  }

  async getRandomTracks(
    options: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {},
  ): Promise<Track[]> {
    return this.tracksQuery({
      sortBy: ["Random"],
      limit: options.size ?? 20,
      genres: options.genre,
      years: yearList(options.fromYear, options.toYear),
    });
  }

  async getTrack(id: string): Promise<Track> {
    return mapTrack(this.sid, await this.getItem(id));
  }

  async getGenres(): Promise<Genre[]> {
    const res = await this.client.getJson<WireQueryResult>("/MusicGenres", {
      userId: this.userId,
      fields: ["ItemCounts"],
      sortBy: ["SortName"],
      sortOrder: "Ascending",
      enableImages: false,
    });
    return (res.Items ?? [])
      .filter((g) => g.Name)
      .map((g) => {
        const genre: Genre = { name: g.Name as string };
        if (g.SongCount != null) genre.trackCount = g.SongCount;
        if (g.AlbumCount != null) genre.albumCount = g.AlbumCount;
        return genre;
      });
  }

  async getTracksByGenre(genre: string, options: PageOptions = {}): Promise<Track[]> {
    return this.tracksQuery({
      genres: genre,
      sortBy: ["SortName"],
      sortOrder: "Ascending",
      limit: options.size ?? 50,
      startIndex: options.offset,
    });
  }

  async search(
    query: string,
    limits: { artists?: number; albums?: number; tracks?: number; offset?: number } = {},
  ): Promise<SearchResult> {
    const startIndex = limits.offset ?? 0;
    const common = { searchTerm: query, startIndex };
    const [artists, albums, tracks] = await Promise.all([
      (limits.artists ?? 20) > 0
        ? this.client.getJson<WireQueryResult>("/Artists", {
            userId: this.userId,
            enableTotalRecordCount: false,
            ...common,
            limit: limits.artists ?? 20,
          })
        : undefined,
      (limits.albums ?? 20) > 0
        ? this.items({
            ...common,
            includeItemTypes: "MusicAlbum",
            fields: ALBUM_FIELDS,
            limit: limits.albums ?? 20,
          })
        : undefined,
      (limits.tracks ?? 20) > 0 ? this.tracksQuery({ ...common, limit: limits.tracks ?? 20 }) : undefined,
    ]);
    return {
      artists: (artists?.Items ?? []).map((a) => mapArtist(this.sid, a)),
      albums: (albums ?? []).map((a) => mapAlbum(this.sid, a)),
      tracks: tracks ?? [],
    };
  }

  // --- Favorites ---------------------------------------------------------------------------------

  async getStarred(): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }> {
    const sort = { sortBy: ["SortName"], sortOrder: "Ascending" } as const;
    const [tracks, albums, artists] = await Promise.all([
      this.tracksQuery({ isFavorite: true, ...sort }),
      this.items({ includeItemTypes: "MusicAlbum", fields: ALBUM_FIELDS, isFavorite: true, ...sort }),
      this.client.getJson<WireQueryResult>("/Artists", {
        userId: this.userId,
        isFavorite: true,
        enableTotalRecordCount: false,
        ...sort,
      }),
    ]);
    return {
      tracks,
      albums: albums.map((a) => mapAlbum(this.sid, a)),
      artists: (artists.Items ?? []).map((a) => mapArtist(this.sid, a)),
    };
  }

  async setStarred(_kind: StarrableKind, id: string, starred: boolean): Promise<void> {
    await this.client.send(starred ? "POST" : "DELETE", this.path("/UserFavoriteItems", id), {
      params: { userId: this.userId },
    });
  }

  // --- Playlists ---------------------------------------------------------------------------------

  async getPlaylists(): Promise<Playlist[]> {
    // The list endpoint carries neither the public flag nor sharing info; `getPlaylist` has both.
    const items = await this.items({
      includeItemTypes: "Playlist",
      fields: ["DateCreated", "ChildCount", "Overview"],
      sortBy: ["SortName"],
      sortOrder: "Ascending",
    });
    return items.map((p) => mapPlaylist(this.sid, p));
  }

  async getPlaylist(id: string): Promise<PlaylistDetail> {
    const [item, entries, dto] = await Promise.all([
      this.getItem(id),
      this.client.getJson<WireQueryResult>(this.path("/Playlists", id, "/Items"), {
        userId: this.userId,
        fields: TRACK_FIELDS,
      }),
      this.client.getJson<WirePlaylistDto>(this.path("/Playlists", id)).catch((error: unknown) => {
        // Not allowed to see the sharing info = not the owner.
        if (error instanceof ProviderError && error.kind === "auth") return undefined;
        throw error;
      }),
    ]);
    const mine = dto?.Shares?.find((s) => s.UserId === this.userId);
    return mapPlaylistDetail(this.sid, item, entries.Items ?? [], {
      public: dto?.OpenAccess ?? false,
      readOnly: dto === undefined || item.CanDelete === false || mine?.CanEdit === false,
    });
  }

  async createPlaylist(name: string, trackIds: string[] = []): Promise<Playlist> {
    const created = await this.client.postJson<{ Id?: string }>("/Playlists", {
      Name: name,
      Ids: trackIds,
      UserId: this.userId,
      MediaType: "Audio",
      IsPublic: false,
    });
    if (!created.Id) throw new ProviderError("invalidResponse", "Playlist creation returned no id");
    const item = await this.getItem(created.Id);
    return mapPlaylist(this.sid, item, {
      public: false,
      readOnly: false,
      trackCount: item.ChildCount ?? trackIds.length,
    });
  }

  /** Jellyfin playlists have a name and a public flag; there is no description field to change. */
  async updatePlaylist(
    id: string,
    changes: { name?: string; comment?: string; public?: boolean },
  ): Promise<void> {
    if (changes.name === undefined && changes.public === undefined) {
      if (changes.comment !== undefined) {
        throw new ProviderError("unsupported", "Jellyfin playlists have no description");
      }
      return;
    }
    await this.client.send("POST", this.path("/Playlists", id), {
      json: { Name: changes.name, IsPublic: changes.public },
    });
  }

  async addToPlaylist(id: string, trackIds: string[]): Promise<void> {
    for (const ids of chunk(trackIds, ID_CHUNK)) {
      await this.client.send("POST", this.path("/Playlists", id, "/Items"), {
        params: { ids, userId: this.userId },
      });
    }
  }

  /** Entry ids of a playlist in their current order. */
  private async playlistEntries(id: string): Promise<string[]> {
    const res = await this.client.getJson<WireQueryResult>(this.path("/Playlists", id, "/Items"), {
      userId: this.userId,
      enableImages: false,
      enableUserData: false,
    });
    return (res.Items ?? []).map((i) => i.PlaylistItemId || i.Id);
  }

  private async removeEntries(id: string, entryIds: readonly string[]): Promise<void> {
    for (const ids of chunk([...new Set(entryIds)], ID_CHUNK)) {
      await this.client.send("DELETE", this.path("/Playlists", id, "/Items"), { params: { entryIds: ids } });
    }
  }

  async removeFromPlaylist(id: string, indices: number[]): Promise<void> {
    if (indices.length === 0) return;
    const entries = await this.playlistEntries(id);
    const wanted = indices.map((i) => entries[i]).filter((e): e is string => e !== undefined);
    await this.removeEntries(id, wanted);
  }

  async reorderPlaylist(id: string, tracks: Track[]): Promise<void> {
    const current = await this.playlistEntries(id);
    const target = tracks.map((t) => t.playlistEntryId);
    const unique = new Set(current).size === current.length;
    const sameEntries =
      unique &&
      target.length === current.length &&
      target.every((entry): entry is string => entry !== undefined) &&
      new Set(target).size === current.length &&
      target.every((entry) => current.includes(entry as string));

    if (sameEntries) {
      try {
        for (const move of planPlaylistMoves(current, target as string[])) {
          await this.client.send(
            "POST",
            this.path("/Playlists", id, `/Items/${encodeURIComponent(move.entryId)}/Move/${move.newIndex}`),
          );
        }
        return;
      } catch {
        // Fall through to the slower, always-working rebuild below.
      }
    }
    await this.removeEntries(id, current);
    await this.addToPlaylist(
      id,
      tracks.map((t) => t.id),
    );
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.client.send("DELETE", this.path("/Items", id));
  }

  // --- Lyrics ------------------------------------------------------------------------------------

  async getLyrics(track: Track): Promise<Lyrics | null> {
    try {
      return mapLyrics(await this.client.getJson<WireLyricDto>(this.path("/Audio", track.id, "/Lyrics")));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "notFound") return null;
      throw error;
    }
  }

  // --- Media -------------------------------------------------------------------------------------

  getStreamSource(track: Track, quality?: StreamQuality): StreamSource {
    return this.mediaSource(false, track, quality);
  }

  getDownloadSource(track: Track, quality?: StreamQuality): StreamSource {
    return this.mediaSource(true, track, quality);
  }

  /**
   * Original quality is the untouched file (`static=true` stream, or `/Download`); a bitrate limit goes
   * through the universal endpoint, which always transcodes because no direct-play container is offered.
   * Credentials travel in the Authorization header only, never in the URL.
   */
  private mediaSource(download: boolean, track: Track, quality?: StreamQuality): StreamSource {
    const kbps = quality?.maxBitRateKbps;
    const transcoded = kbps !== undefined && kbps > 0;
    const headers = this.client.authHeaders;

    if (!transcoded) {
      const url = download
        ? this.client.url(this.path("/Items", track.id, "/Download"))
        : this.client.url(this.path("/Audio", track.id, "/stream"), {
            static: true,
            mediaSourceId: track.id,
          });
      const source: StreamSource = {
        url,
        headers,
        cacheKey: `${this.sid}:${track.id}:raw:0`,
        transcoded: false,
      };
      if (track.format.container) source.container = track.format.container;
      return source;
    }

    const format = transcodeFormat(quality?.format);
    const bitsPerSecond = Math.round(kbps * 1000);
    return {
      url: this.client.url(this.path("/Audio", track.id, "/universal"), {
        userId: this.userId,
        deviceId: this.client.deviceId,
        mediaSourceId: track.id,
        audioCodec: format.codec,
        transcodingContainer: format.container,
        transcodingProtocol: "http",
        audioBitRate: bitsPerSecond,
        maxStreamingBitrate: bitsPerSecond,
      }),
      headers,
      cacheKey: `${this.sid}:${track.id}:${format.name}:${kbps}`,
      transcoded: true,
      container: format.container,
      timeOffset: { param: "startTimeTicks", unit: "ticks" },
    };
  }

  coverUrl(cover: CoverRef, size?: number): string {
    const { id, tag } = parseCover(cover);
    return this.client.url(this.path("/Items", id, "/Images/Primary"), {
      fillWidth: size,
      fillHeight: size,
      quality: 90,
      tag,
    });
  }

  // --- Reporting ---------------------------------------------------------------------------------

  /** Jellyfin counts a play when the "stopped" report arrives, so the player must always send it. */
  async reportPlayback(event: PlaybackEvent): Promise<void> {
    switch (event.type) {
      case "start":
        await this.client.send("POST", "/Sessions/Playing", {
          json: {
            ItemId: event.trackId,
            MediaSourceId: event.trackId,
            PositionTicks: msToTicks(event.positionMs),
            CanSeek: true,
          },
        });
        return;
      case "progress":
        await this.client.send("POST", "/Sessions/Playing/Progress", {
          json: {
            ItemId: event.trackId,
            MediaSourceId: event.trackId,
            PositionTicks: msToTicks(event.positionMs),
            IsPaused: event.paused,
            CanSeek: true,
          },
        });
        return;
      case "stop":
        await this.client.send("POST", "/Sessions/Playing/Stopped", {
          json: {
            ItemId: event.trackId,
            MediaSourceId: event.trackId,
            PositionTicks: msToTicks(event.positionMs),
          },
        });
        return;
      case "scrobble":
        // Nothing to do: the server derives plays from the playback reports above.
        return;
    }
  }
}

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
  type SavedPlayQueue,
  type SearchResult,
  type ServerConfig,
  type StarrableKind,
  type StreamQuality,
  type StreamSource,
  type Track,
} from "../provider";
import type { SubsonicClient } from "./client";
import {
  mapAlbum,
  mapAlbumDetail,
  mapArtist,
  mapArtistDetail,
  mapLegacyLyrics,
  mapPlaylist,
  mapPlaylistDetail,
  mapStructuredLyrics,
  mapTrack,
} from "./mappers";
import type { WireChild } from "./wire";

const ALBUM_LIST_TYPES: Record<AlbumListType, string> = {
  recentlyPlayed: "recent",
  recentlyAdded: "newest",
  mostPlayed: "frequent",
  random: "random",
  starred: "starred",
  alphabeticalByName: "alphabeticalByName",
  alphabeticalByArtist: "alphabeticalByArtist",
  highestRated: "highest",
  byYear: "byYear",
  byGenre: "byGenre",
};

/** Above this many ids a GET URL gets risky; POST is used if the server supports `formPost`. */
const POST_ID_THRESHOLD = 200;

export class SubsonicProvider implements MusicProvider {
  constructor(
    private readonly client: SubsonicClient,
    readonly capabilities: Capabilities,
    formPost: boolean,
  ) {
    client.formPost = formPost;
  }

  get server(): ServerConfig {
    return this.client.server;
  }

  private get sid(): string {
    return this.client.server.id;
  }

  private tracks(list: WireChild[] | undefined): Track[] {
    return (list ?? []).map((c) => mapTrack(this.sid, c));
  }

  private usePost(idCount: number): boolean {
    return this.client.formPost && idCount > POST_ID_THRESHOLD;
  }

  async ping(): Promise<void> {
    await this.client.call("ping");
  }

  // --- Browsing ----------------------------------------------------------------------------------

  async getAlbumList(type: AlbumListType, options: AlbumListOptions = {}): Promise<Album[]> {
    const res = await this.client.call("getAlbumList2", {
      type: ALBUM_LIST_TYPES[type],
      size: Math.min(Math.max(options.size ?? 50, 1), 500),
      offset: options.offset,
      genre: type === "byGenre" ? options.genre : undefined,
      fromYear: type === "byYear" ? (options.fromYear ?? 0) : undefined,
      toYear: type === "byYear" ? (options.toYear ?? 9999) : undefined,
    });
    return (res.albumList2?.album ?? []).map((a) => mapAlbum(this.sid, a));
  }

  async getAlbum(id: string): Promise<AlbumDetail> {
    const res = await this.client.call("getAlbum", { id });
    if (!res.album) throw new ProviderError("invalidResponse", "getAlbum returned no album");
    return mapAlbumDetail(this.sid, res.album);
  }

  async getArtists(): Promise<Artist[]> {
    const res = await this.client.call("getArtists");
    return (res.artists?.index ?? []).flatMap((i) => i.artist ?? []).map((a) => mapArtist(this.sid, a));
  }

  async getArtist(id: string): Promise<ArtistDetail> {
    const res = await this.client.call("getArtist", { id });
    if (!res.artist) throw new ProviderError("invalidResponse", "getArtist returned no artist");
    return mapArtistDetail(this.sid, res.artist);
  }

  async getArtistInfo(id: string): Promise<ArtistInfo | null> {
    const res = await this.client.call("getArtistInfo2", { id });
    const info = res.artistInfo2;
    if (!info) return null;
    const similar = (info.similarArtist ?? []).map((a) => mapArtist(this.sid, a));
    const result: ArtistInfo = { similarArtists: similar };
    if (info.biography?.trim()) result.biography = info.biography;
    if (info.largeImageUrl) result.imageUrl = info.largeImageUrl;
    if (info.lastFmUrl) result.externalUrl = info.lastFmUrl;
    if (!result.biography && !result.imageUrl && !result.externalUrl && similar.length === 0) return null;
    return result;
  }

  async getTopTracks(artist: ArtistRef, count = 20): Promise<Track[]> {
    const res = await this.client.call("getTopSongs", { artist: artist.name, count });
    return this.tracks(res.topSongs?.song);
  }

  async getSimilarTracks(trackId: string, count = 30): Promise<Track[]> {
    const res = await this.client.call("getSimilarSongs2", { id: trackId, count });
    return this.tracks(res.similarSongs2?.song);
  }

  async getRandomTracks(
    options: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {},
  ): Promise<Track[]> {
    const res = await this.client.call("getRandomSongs", {
      size: options.size ?? 20,
      genre: options.genre,
      fromYear: options.fromYear,
      toYear: options.toYear,
    });
    return this.tracks(res.randomSongs?.song);
  }

  async getTrack(id: string): Promise<Track> {
    const res = await this.client.call("getSong", { id });
    if (!res.song) throw new ProviderError("invalidResponse", "getSong returned no song");
    return mapTrack(this.sid, res.song);
  }

  async getGenres(): Promise<Genre[]> {
    const res = await this.client.call("getGenres");
    return (res.genres?.genre ?? []).map((g) => ({
      name: g.value,
      trackCount: g.songCount,
      albumCount: g.albumCount,
    }));
  }

  async getTracksByGenre(genre: string, options: PageOptions = {}): Promise<Track[]> {
    const res = await this.client.call("getSongsByGenre", {
      genre,
      count: options.size ?? 50,
      offset: options.offset,
    });
    return this.tracks(res.songsByGenre?.song);
  }

  async search(
    query: string,
    limits: { artists?: number; albums?: number; tracks?: number; offset?: number } = {},
  ): Promise<SearchResult> {
    const offset = limits.offset ?? 0;
    const res = await this.client.call("search3", {
      query,
      artistCount: limits.artists ?? 20,
      albumCount: limits.albums ?? 20,
      songCount: limits.tracks ?? 20,
      artistOffset: offset,
      albumOffset: offset,
      songOffset: offset,
    });
    const r = res.searchResult3;
    return {
      artists: (r?.artist ?? []).map((a) => mapArtist(this.sid, a)),
      albums: (r?.album ?? []).map((a) => mapAlbum(this.sid, a)),
      tracks: this.tracks(r?.song),
    };
  }

  // --- Favorites ---------------------------------------------------------------------------------

  async getStarred(): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }> {
    const res = await this.client.call("getStarred2");
    const s = res.starred2;
    return {
      tracks: this.tracks(s?.song),
      albums: (s?.album ?? []).map((a) => mapAlbum(this.sid, a)),
      artists: (s?.artist ?? []).map((a) => mapArtist(this.sid, a)),
    };
  }

  async setStarred(kind: StarrableKind, id: string, starred: boolean): Promise<void> {
    const key = kind === "track" ? "id" : kind === "album" ? "albumId" : "artistId";
    await this.client.call(starred ? "star" : "unstar", { [key]: id });
  }

  async setRating(trackId: string, rating: number | null): Promise<void> {
    const value = rating === null ? 0 : Math.min(Math.max(Math.round(rating), 0), 5);
    await this.client.call("setRating", { id: trackId, rating: value });
  }

  // --- Playlists ---------------------------------------------------------------------------------

  async getPlaylists(): Promise<Playlist[]> {
    const res = await this.client.call("getPlaylists");
    return (res.playlists?.playlist ?? []).map((p) => mapPlaylist(this.sid, p, this.server.username));
  }

  async getPlaylist(id: string): Promise<PlaylistDetail> {
    const res = await this.client.call("getPlaylist", { id });
    if (!res.playlist) throw new ProviderError("invalidResponse", "getPlaylist returned no playlist");
    return mapPlaylistDetail(this.sid, res.playlist, this.server.username);
  }

  async createPlaylist(name: string, trackIds: string[] = []): Promise<Playlist> {
    const res = await this.client.call(
      "createPlaylist",
      { name, songId: trackIds },
      { post: this.usePost(trackIds.length) },
    );
    if (!res.playlist) throw new ProviderError("invalidResponse", "createPlaylist returned no playlist");
    return mapPlaylist(this.sid, res.playlist, this.server.username);
  }

  async updatePlaylist(
    id: string,
    changes: { name?: string; comment?: string; public?: boolean },
  ): Promise<void> {
    await this.client.call("updatePlaylist", {
      playlistId: id,
      name: changes.name,
      comment: changes.comment,
      public: changes.public,
    });
  }

  async addToPlaylist(id: string, trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    await this.client.call(
      "updatePlaylist",
      { playlistId: id, songIdToAdd: trackIds },
      { post: this.usePost(trackIds.length) },
    );
  }

  async removeFromPlaylist(id: string, indices: number[]): Promise<void> {
    if (indices.length === 0) return;
    await this.client.call(
      "updatePlaylist",
      { playlistId: id, songIndexToRemove: indices },
      { post: this.usePost(indices.length) },
    );
  }

  async reorderPlaylist(id: string, tracks: Track[]): Promise<void> {
    const ids = tracks.map((t) => t.id);
    const post = this.usePost(ids.length);
    if (this.capabilities.playlistReorder === "replace") {
      // Navidrome replaces all tracks of an existing playlist in one transaction (ignores `name`).
      await this.client.call("createPlaylist", { playlistId: id, songId: ids }, { post });
      return;
    }
    await this.client.call(
      "updatePlaylist",
      { playlistId: id, songIndexToRemove: ids.map((_, i) => i), songIdToAdd: ids },
      { post },
    );
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.client.call("deletePlaylist", { id });
  }

  // --- Lyrics ------------------------------------------------------------------------------------

  async getLyrics(track: Track): Promise<Lyrics | null> {
    if (this.capabilities.syncedLyrics) {
      try {
        const res = await this.client.call("getLyricsBySongId", {
          id: track.id,
          enhanced: this.capabilities.wordSyncedLyrics ? true : undefined,
        });
        return mapStructuredLyrics(res.lyricsList?.structuredLyrics);
      } catch (error) {
        if (error instanceof ProviderError && error.kind === "notFound") return null;
        throw error;
      }
    }
    const artist = track.artists[0]?.name ?? track.artistLine;
    const res = await this.client.call("getLyrics", { artist, title: track.title });
    return mapLegacyLyrics(res.lyrics?.value);
  }

  // --- Media -------------------------------------------------------------------------------------

  getStreamSource(track: Track, quality?: StreamQuality): StreamSource {
    return this.mediaSource("stream", track, quality);
  }

  getDownloadSource(track: Track, quality?: StreamQuality): StreamSource {
    const transcode = quality?.maxBitRateKbps !== undefined && quality.maxBitRateKbps > 0;
    return this.mediaSource(transcode ? "stream" : "download", track, quality);
  }

  private mediaSource(endpoint: "stream" | "download", track: Track, quality?: StreamQuality): StreamSource {
    const kbps = quality?.maxBitRateKbps;
    const transcoded = kbps !== undefined && kbps > 0;
    const format = transcoded ? (quality?.format ?? "mp3") : undefined;
    const url = this.client.mediaUrl(
      endpoint,
      transcoded
        ? { id: track.id, format, maxBitRate: kbps, estimateContentLength: true }
        : { id: track.id, format: endpoint === "stream" ? "raw" : undefined },
    );
    const source: StreamSource = {
      url,
      headers: {},
      cacheKey: `${this.sid}:${track.id}:${format ?? "raw"}:${transcoded ? kbps : 0}`,
      transcoded,
      container: transcoded ? format : track.format.container,
    };
    if (transcoded && this.capabilities.transcodeOffset) {
      source.timeOffset = { param: "timeOffset", unit: "seconds" };
    }
    return source;
  }

  coverUrl(cover: CoverRef, size?: number): string {
    return this.client.mediaUrl("getCoverArt", { id: cover, size });
  }

  // --- Reporting ---------------------------------------------------------------------------------

  async reportPlayback(event: PlaybackEvent): Promise<void> {
    if (event.type === "start") {
      await this.client.call("scrobble", { id: event.trackId, submission: false });
    } else if (event.type === "scrobble") {
      await this.client.call("scrobble", {
        id: event.trackId,
        time: event.playedAt.getTime(),
        submission: true,
      });
    }
  }

  // --- Play queue --------------------------------------------------------------------------------

  async savePlayQueue(queue: SavedPlayQueue): Promise<void> {
    await this.client.call(
      "savePlayQueue",
      { id: queue.trackIds, current: queue.currentId, position: Math.round(queue.positionMs) },
      { post: this.usePost(queue.trackIds.length) },
    );
  }

  async getPlayQueue(): Promise<SavedPlayQueue | null> {
    const res = await this.client.call("getPlayQueue");
    const q = res.playQueue;
    const entries = q?.entry ?? [];
    if (!q || entries.length === 0) return null;
    const saved: SavedPlayQueue = { trackIds: entries.map((e) => e.id), positionMs: q.position ?? 0 };
    if (q.current) saved.currentId = q.current;
    if (q.changed) saved.changedAt = q.changed;
    if (q.changedBy) saved.changedBy = q.changedBy;
    return saved;
  }
}

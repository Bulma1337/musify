import {
  ProviderError,
  type Album,
  type AlbumDetail,
  type AlbumListOptions,
  type AlbumListType,
  type Artist,
  type ArtistDetail,
  type Capabilities,
  type Genre,
  type MusicProvider,
  type Playlist,
  type PlaylistDetail,
  type SearchResult,
  type ServerConfig,
  type StreamSource,
  type Track,
} from "@/api/provider";
import { downloadsApi } from "./api";
import { doneEntries, useDownloads } from "./store";
import type { CollectionEntry } from "./types";

const OFFLINE_CAPABILITIES: Capabilities = {
  lyrics: false,
  syncedLyrics: false,
  wordSyncedLyrics: false,
  similarTracks: false,
  artistInfo: false,
  topTracks: true,
  playQueueSync: false,
  transcodeOffset: false,
  playlistReorder: "replace",
  publicPlaylists: false,
  ratings: false,
  transcoding: false,
};

const offlineError = () => new ProviderError("network", "The server is not reachable (offline mode)");
const notFound = (what: string) => new ProviderError("notFound", `${what} is not downloaded`);

function matches(track: Track, query: string): boolean {
  const q = query.toLowerCase();
  return (
    track.title.toLowerCase().includes(q) ||
    track.artistLine.toLowerCase().includes(q) ||
    (track.album?.name.toLowerCase().includes(q) ?? false)
  );
}

function sumDuration(tracks: Track[]): number {
  return tracks.reduce((sum, t) => sum + t.durationMs, 0);
}

/** An album assembled from downloaded tracks that carry the album's id. */
function albumFromTracks(id: string, tracks: Track[], addedAt?: number): Album {
  const first = tracks[0]!;
  const years = tracks.map((t) => t.year).filter((y): y is number => y != null);
  return {
    id,
    serverId: first.serverId,
    name: first.album?.name ?? first.title,
    artists: first.albumArtists.length > 0 ? first.albumArtists : first.artists,
    artistLine: (first.albumArtists.length > 0 ? first.albumArtists : first.artists)
      .map((a) => a.name)
      .join(", "),
    year: years.length > 0 ? Math.min(...years) : undefined,
    genres: [...new Set(tracks.flatMap((t) => t.genres))],
    cover: first.cover,
    trackCount: tracks.length,
    durationMs: sumDuration(tracks),
    addedAt: addedAt ? new Date(addedAt).toISOString() : undefined,
    starred: false,
  };
}

function sortTracksOfAlbum(tracks: Track[]): Track[] {
  return [...tracks].sort(
    (a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
  );
}

/**
 * The library as far as it is downloaded: serves the `MusicProvider` interface from the downloads
 * store, so every page works offline without knowing about it. Anything that needs the server
 * rejects with a network error.
 */
export class OfflineProvider implements MusicProvider {
  readonly capabilities = OFFLINE_CAPABILITIES;

  constructor(readonly server: ServerConfig) {}

  private get store() {
    return useDownloads.getState();
  }

  /** Downloaded tracks (finished files only), oldest download first. */
  private tracks(): Track[] {
    return doneEntries(this.store.entries).map((e) => e.track);
  }

  private trackMap(): Map<string, Track> {
    return new Map(this.tracks().map((t) => [t.id, t]));
  }

  private collection(kind: CollectionEntry["kind"], id: string): CollectionEntry | undefined {
    return Object.values(this.store.collections).find((c) => c.kind === kind && c.itemId === id);
  }

  private collectionTracks(collection: CollectionEntry): Track[] {
    const byId = this.trackMap();
    return collection.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t);
  }

  /** Albums: downloaded album collections plus albums assembled from single tracks. */
  private albums(): Album[] {
    const result = new Map<string, Album>();
    for (const c of Object.values(this.store.collections)) {
      if (c.kind !== "album" || c.snapshot.kind !== "album") continue;
      const tracks = this.collectionTracks(c);
      if (tracks.length === 0) continue;
      result.set(c.itemId, {
        ...c.snapshot.album,
        starred: true,
        trackCount: tracks.length,
        durationMs: sumDuration(tracks),
        addedAt: new Date(c.addedAt).toISOString(),
      });
    }
    const loose = new Map<string, Track[]>();
    for (const entry of doneEntries(this.store.entries)) {
      const id = entry.track.album?.id;
      if (!id || result.has(id)) continue;
      const list = loose.get(id) ?? [];
      list.push(entry.track);
      loose.set(id, list);
    }
    for (const [id, tracks] of loose) result.set(id, albumFromTracks(id, tracks));
    return [...result.values()];
  }

  async ping(): Promise<void> {
    throw offlineError();
  }

  // --- Browsing ----------------------------------------------------------------------------------

  async getAlbumList(type: AlbumListType, options?: AlbumListOptions): Promise<Album[]> {
    let albums = this.albums();
    switch (type) {
      case "alphabeticalByName":
        albums.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "alphabeticalByArtist":
        albums.sort((a, b) => a.artistLine.localeCompare(b.artistLine));
        break;
      case "byYear":
        albums = albums.filter(
          (a) =>
            a.year != null &&
            a.year >= (options?.fromYear ?? 0) &&
            a.year <= (options?.toYear ?? Number.MAX_SAFE_INTEGER),
        );
        break;
      case "byGenre":
        albums = albums.filter((a) => options?.genre != null && a.genres.includes(options.genre));
        break;
      case "random":
        albums.sort(() => Math.random() - 0.5);
        break;
      default:
        // Newest download first (recently added/played, most played, starred …).
        albums.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
    }
    const offset = options?.offset ?? 0;
    return albums.slice(offset, offset + (options?.size ?? 50));
  }

  async getAlbum(id: string): Promise<AlbumDetail> {
    const collection = this.collection("album", id);
    if (collection && collection.snapshot.kind === "album") {
      const tracks = this.collectionTracks(collection);
      if (tracks.length > 0) {
        return {
          ...collection.snapshot.album,
          starred: true,
          trackCount: tracks.length,
          durationMs: sumDuration(tracks),
          tracks,
        };
      }
    }
    const tracks = sortTracksOfAlbum(this.tracks().filter((t) => t.album?.id === id));
    if (tracks.length === 0) throw notFound("album");
    return { ...albumFromTracks(id, tracks), tracks };
  }

  async getArtists(): Promise<Artist[]> {
    const artists = new Map<string, Artist>();
    for (const track of this.tracks()) {
      for (const ref of [...track.albumArtists, ...track.artists]) {
        if (!ref.id || artists.has(ref.id)) continue;
        artists.set(ref.id, {
          id: ref.id,
          serverId: this.server.id,
          name: ref.name,
          starred: false,
        });
      }
    }
    return [...artists.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getArtist(id: string): Promise<ArtistDetail> {
    const tracks = this.tracks().filter(
      (t) => t.albumArtists.some((a) => a.id === id) || t.artists.some((a) => a.id === id),
    );
    const ref = tracks.flatMap((t) => [...t.albumArtists, ...t.artists]).find((a) => a.id === id);
    if (!ref) throw notFound("artist");
    const albums = this.albums()
      .filter((a) => a.artists.some((x) => x.id === id))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return {
      id,
      serverId: this.server.id,
      name: ref.name,
      albumCount: albums.length,
      starred: false,
      albums,
    };
  }

  async getArtistInfo(): Promise<null> {
    return null;
  }

  async getTopTracks(artist: { id?: string; name: string }, count = 10): Promise<Track[]> {
    return this.tracks()
      .filter((t) => t.artists.some((a) => (artist.id ? a.id === artist.id : a.name === artist.name)))
      .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
      .slice(0, count);
  }

  async getSimilarTracks(): Promise<Track[]> {
    return [];
  }

  async getRandomTracks(options?: { size?: number; genre?: string }): Promise<Track[]> {
    const pool = this.tracks().filter((t) => !options?.genre || t.genres.includes(options.genre));
    return pool.sort(() => Math.random() - 0.5).slice(0, options?.size ?? 20);
  }

  async getTrack(id: string): Promise<Track> {
    const track = this.trackMap().get(id);
    if (!track) throw notFound("track");
    return track;
  }

  async getGenres(): Promise<Genre[]> {
    const genres = new Map<string, { tracks: number; albums: Set<string> }>();
    for (const track of this.tracks()) {
      for (const name of track.genres) {
        const info = genres.get(name) ?? { tracks: 0, albums: new Set() };
        info.tracks++;
        if (track.album) info.albums.add(track.album.id);
        genres.set(name, info);
      }
    }
    return [...genres.entries()]
      .map(([name, info]) => ({ name, trackCount: info.tracks, albumCount: info.albums.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTracksByGenre(genre: string): Promise<Track[]> {
    return this.tracks().filter((t) => t.genres.includes(genre));
  }

  async search(
    query: string,
    limits?: { artists?: number; albums?: number; tracks?: number },
  ): Promise<SearchResult> {
    const q = query.trim().toLowerCase();
    const [artists, albums] = [await this.getArtists(), this.albums()];
    return {
      artists: artists.filter((a) => a.name.toLowerCase().includes(q)).slice(0, limits?.artists ?? 20),
      albums: albums
        .filter((a) => a.name.toLowerCase().includes(q) || a.artistLine.toLowerCase().includes(q))
        .slice(0, limits?.albums ?? 20),
      tracks: this.tracks()
        .filter((t) => matches(t, q))
        .slice(0, limits?.tracks ?? 50),
    };
  }

  // --- Favorites and playlists (from the downloaded collections) -----------------------------------

  async getStarred(): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }> {
    const favorites = this.collection("favorites", "favorites");
    const downloaded = new Set(
      Object.values(this.store.collections)
        .filter((c) => c.kind === "album")
        .map((c) => c.itemId),
    );
    return {
      tracks: favorites ? this.collectionTracks(favorites) : [],
      albums: this.albums().filter((a) => downloaded.has(a.id)),
      artists: [],
    };
  }

  async setStarred(): Promise<void> {
    throw offlineError();
  }

  private playlistOf(collection: CollectionEntry): Playlist | null {
    if (collection.snapshot.kind !== "playlist") return null;
    const tracks = this.collectionTracks(collection);
    return {
      ...collection.snapshot.playlist,
      trackCount: tracks.length,
      durationMs: sumDuration(tracks),
      readOnly: true,
    };
  }

  async getPlaylists(): Promise<Playlist[]> {
    return Object.values(this.store.collections)
      .filter((c) => c.kind === "playlist")
      .map((c) => this.playlistOf(c))
      .filter((p): p is Playlist => !!p);
  }

  async getPlaylist(id: string): Promise<PlaylistDetail> {
    const collection = this.collection("playlist", id);
    const playlist = collection && this.playlistOf(collection);
    if (!collection || !playlist) throw notFound("playlist");
    return { ...playlist, tracks: this.collectionTracks(collection) };
  }

  async createPlaylist(): Promise<Playlist> {
    throw offlineError();
  }
  async updatePlaylist(): Promise<void> {
    throw offlineError();
  }
  async addToPlaylist(): Promise<void> {
    throw offlineError();
  }
  async removeFromPlaylist(): Promise<void> {
    throw offlineError();
  }
  async reorderPlaylist(): Promise<void> {
    throw offlineError();
  }
  async deletePlaylist(): Promise<void> {
    throw offlineError();
  }

  async getLyrics(): Promise<null> {
    return null;
  }

  // --- Media -----------------------------------------------------------------------------------------

  getStreamSource(): StreamSource {
    throw offlineError();
  }

  getDownloadSource(): StreamSource {
    throw offlineError();
  }

  /** Covers saved with downloaded albums; everything else shows the placeholder. */
  coverUrl(cover: string): string {
    return downloadsApi.coverSrc(this.server.id, cover);
  }

  async reportPlayback(): Promise<void> {}
}

/** Creates the offline provider after loading what is downloaded for the server. */
export async function createOfflineProvider(server: ServerConfig): Promise<MusicProvider> {
  await useDownloads.getState().load(server.id);
  return new OfflineProvider(server);
}

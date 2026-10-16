import type {
  Album,
  AlbumDetail,
  Artist,
  ArtistDetail,
  Capabilities,
  MusicProvider,
  Playlist,
  PlaylistDetail,
  ServerConfig,
  Track,
} from "@/api/provider";
import { ProviderError } from "@/api/provider";

/** In-memory library for page tests: 2 artists, 3 albums, 9 tracks, 1 playlist. */
export const fakeServer: ServerConfig = {
  id: "srv1",
  kind: "subsonic",
  name: "Test Server",
  url: "http://test.local",
  username: "tester",
  serverType: "navidrome",
  addedAt: "2026-01-01T00:00:00Z",
};

const capabilities: Capabilities = {
  lyrics: true,
  syncedLyrics: true,
  wordSyncedLyrics: false,
  similarTracks: true,
  artistInfo: true,
  topTracks: true,
  playQueueSync: true,
  transcodeOffset: true,
  playlistReorder: "replace",
  publicPlaylists: true,
  ratings: true,
  transcoding: true,
};

export const fakeArtists: Artist[] = [
  { id: "ar1", serverId: "srv1", name: "Aurora Lane", cover: "ar-ar1", albumCount: 2, starred: true },
  { id: "ar2", serverId: "srv1", name: "Kollektiv Nord", cover: "ar-ar2", albumCount: 1, starred: false },
];

function track(
  n: number,
  albumId: string,
  albumName: string,
  artist: Artist,
  extra: Partial<Track> = {},
): Track {
  return {
    id: `t${n}`,
    serverId: "srv1",
    title: `Song ${n}`,
    artists: [{ id: artist.id, name: artist.name }],
    artistLine: artist.name,
    albumArtists: [{ id: artist.id, name: artist.name }],
    album: { id: albumId, name: albumName },
    durationMs: 180_000 + n * 1000,
    trackNumber: ((n - 1) % 3) + 1,
    discNumber: 1,
    year: 2024,
    genres: ["Electronic"],
    cover: albumId,
    format: { container: "flac", bitDepth: 16, sampleRate: 44100, bitRate: 900 },
    starred: n % 4 === 0,
    playCount: n,
    ...extra,
  };
}

const a1 = fakeArtists[0]!;
const a2 = fakeArtists[1]!;

export const fakeTracks: Track[] = [
  track(1, "al1", "Morning Static", a1),
  track(2, "al1", "Morning Static", a1, { explicit: true }),
  track(3, "al1", "Morning Static", a1),
  track(4, "al2", "Night Drive", a1),
  track(5, "al2", "Night Drive", a1),
  track(6, "al2", "Night Drive", a1, { discNumber: 2 }),
  track(7, "al3", "Nordlicht", a2),
  track(8, "al3", "Nordlicht", a2),
  track(9, "al3", "Nordlicht", a2),
];

function albumFrom(id: string, name: string, artist: Artist, year: number): Album {
  const tracks = fakeTracks.filter((t) => t.album?.id === id);
  return {
    id,
    serverId: "srv1",
    name,
    artists: [{ id: artist.id, name: artist.name }],
    artistLine: artist.name,
    year,
    genres: ["Electronic"],
    cover: id,
    trackCount: tracks.length,
    durationMs: tracks.reduce((sum, t) => sum + t.durationMs, 0),
    addedAt: "2026-03-13T10:00:00Z",
    starred: id === "al1",
    releaseType: "album",
  };
}

export const fakeAlbums: Album[] = [
  albumFrom("al1", "Morning Static", a1, 2024),
  albumFrom("al2", "Night Drive", a1, 2022),
  albumFrom("al3", "Nordlicht", a2, 2023),
];

export const fakePlaylists: PlaylistDetail[] = [
  {
    id: "pl1",
    serverId: "srv1",
    name: "Road Trip",
    comment: "Songs for the highway",
    owner: "tester",
    public: false,
    trackCount: 4,
    durationMs: fakeTracks.slice(0, 4).reduce((s, t) => s + t.durationMs, 0),
    cover: "pl-pl1",
    createdAt: "2026-02-01T00:00:00Z",
    changedAt: "2026-03-01T00:00:00Z",
    readOnly: false,
    tracks: [fakeTracks[0]!, fakeTracks[4]!, fakeTracks[6]!, fakeTracks[8]!],
  },
];

const notFound = (what: string) => new ProviderError("notFound", `${what} not found`);

/** A complete MusicProvider backed by the fixtures above. Mutations are recorded in `calls`. */
export function createFakeProvider(): MusicProvider & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  return {
    server: fakeServer,
    capabilities,
    calls,
    async ping() {},
    async getAlbumList(_type, options) {
      return fakeAlbums.slice(0, options?.size ?? 50);
    },
    async getAlbum(id): Promise<AlbumDetail> {
      const album = fakeAlbums.find((a) => a.id === id);
      if (!album) throw notFound("album");
      return { ...album, tracks: fakeTracks.filter((t) => t.album?.id === id) };
    },
    async getArtists() {
      return fakeArtists;
    },
    async getArtist(id): Promise<ArtistDetail> {
      const artist = fakeArtists.find((a) => a.id === id);
      if (!artist) throw notFound("artist");
      return { ...artist, albums: fakeAlbums.filter((a) => a.artists[0]?.id === id) };
    },
    async getArtistInfo(id) {
      return {
        biography: `Biography of ${fakeArtists.find((a) => a.id === id)?.name ?? "?"}.`,
        similarArtists: fakeArtists.filter((a) => a.id !== id),
      };
    },
    async getTopTracks(artist, count = 10) {
      return fakeTracks.filter((t) => t.artists[0]?.id === artist.id).slice(0, count);
    },
    async getSimilarTracks() {
      return fakeTracks.slice(0, 5);
    },
    async getRandomTracks(options) {
      return fakeTracks.slice(0, options?.size ?? 20);
    },
    async getTrack(id) {
      const found = fakeTracks.find((t) => t.id === id);
      if (!found) throw notFound("track");
      return found;
    },
    async getGenres() {
      return [
        { name: "Electronic", trackCount: 9, albumCount: 3 },
        { name: "Jazz", trackCount: 0, albumCount: 0 },
      ];
    },
    async getTracksByGenre(genre) {
      return fakeTracks.filter((t) => t.genres.includes(genre));
    },
    async search(query) {
      const q = query.toLowerCase();
      return {
        artists: fakeArtists.filter((a) => a.name.toLowerCase().includes(q)),
        albums: fakeAlbums.filter((a) => a.name.toLowerCase().includes(q)),
        tracks: fakeTracks.filter(
          (t) => t.title.toLowerCase().includes(q) || t.artistLine.toLowerCase().includes(q),
        ),
      };
    },
    async getStarred() {
      return {
        tracks: fakeTracks.filter((t) => t.starred),
        albums: fakeAlbums.filter((a) => a.starred),
        artists: fakeArtists.filter((a) => a.starred),
      };
    },
    async setStarred(kind, id, starred) {
      record("setStarred", kind, id, starred);
    },
    async getPlaylists(): Promise<Playlist[]> {
      return fakePlaylists.map(({ tracks: _tracks, ...p }) => p);
    },
    async getPlaylist(id) {
      const playlist = fakePlaylists.find((p) => p.id === id);
      if (!playlist) throw notFound("playlist");
      return playlist;
    },
    async createPlaylist(name, trackIds = []) {
      record("createPlaylist", name, trackIds);
      return { ...fakePlaylists[0]!, id: "pl-new", name, trackCount: trackIds.length };
    },
    async updatePlaylist(id, changes) {
      record("updatePlaylist", id, changes);
    },
    async addToPlaylist(id, trackIds) {
      record("addToPlaylist", id, trackIds);
    },
    async removeFromPlaylist(id, indices) {
      record("removeFromPlaylist", id, indices);
    },
    async reorderPlaylist(id, tracks) {
      record(
        "reorderPlaylist",
        id,
        tracks.map((t) => t.id),
      );
    },
    async deletePlaylist(id) {
      record("deletePlaylist", id);
    },
    async getLyrics() {
      return null;
    },
    getStreamSource(t) {
      return {
        url: `http://test.local/stream/${t.id}`,
        headers: {},
        cacheKey: `srv1:${t.id}:raw:0`,
        transcoded: false,
      };
    },
    getDownloadSource(t) {
      return {
        url: `http://test.local/download/${t.id}`,
        headers: {},
        cacheKey: `srv1:${t.id}:raw:0`,
        transcoded: false,
      };
    },
    coverUrl(cover, size) {
      return `http://test.local/cover/${cover}?size=${size ?? 0}`;
    },
    async reportPlayback(event) {
      record("reportPlayback", event);
    },
  };
}

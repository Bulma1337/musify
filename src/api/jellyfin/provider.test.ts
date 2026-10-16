import type { MusicProvider, Track } from "../provider";
import { jellyfinFactory } from ".";
import { mapAlbum, mapArtist, mapLyrics, mapPlaylist, mapTrack, msToTicks, normalizeContainer, ticksToMs } from "./mappers";
import { planPlaylistMoves } from "./provider";
import { noContent, setupJellyfinMock, status, testServer, type JellyfinCall } from "./testing";
import type { WireItem } from "./wire";

const mock = setupJellyfinMock();
const SECRET = "secret-token-xyz";

async function connectProvider(): Promise<MusicProvider> {
  mock.respond(() => ({ Id: "user1" }));
  const provider = await jellyfinFactory.connect(testServer, SECRET);
  mock.calls.length = 0;
  return provider;
}

const richTrack: WireItem = {
  Id: "t1",
  Name: "Song",
  Type: "Audio",
  Container: "flac",
  RunTimeTicks: 2_005_000_000,
  ProductionYear: 2020,
  IndexNumber: 3,
  ParentIndexNumber: 2,
  Genres: ["Rock", "Pop"],
  Artists: ["A", "B"],
  ArtistItems: [
    { Id: "ar1", Name: "A" },
    { Id: "ar2", Name: "B" },
  ],
  AlbumArtist: "A",
  AlbumArtists: [{ Id: "ar1", Name: "A" }],
  Album: "Alb",
  AlbumId: "al1",
  AlbumPrimaryImageTag: "albtag",
  ImageTags: { Primary: "trktag" },
  NormalizationGain: -6.5,
  ProviderIds: { MusicBrainzTrack: "mbid-1" },
  UserData: { IsFavorite: true, PlayCount: 7, LastPlayedDate: "2024-06-01T10:00:00Z" },
  MediaSources: [
    {
      Id: "t1",
      Container: "flac",
      Size: 1234,
      Bitrate: 950_000,
      MediaStreams: [
        { Type: "Audio", Codec: "FLAC", BitRate: 900_400, SampleRate: 96000, BitDepth: 24, Channels: 2 },
        { Type: "EmbeddedImage", Codec: "mjpeg" },
      ],
    },
  ],
};

const lastCall = (): JellyfinCall => mock.calls[mock.calls.length - 1]!;
const items = (...list: WireItem[]) => ({ Items: list, TotalRecordCount: list.length });

describe("ticks", () => {
  it("converts 100 ns ticks to milliseconds and back", () => {
    expect(ticksToMs(10_000)).toBe(1);
    expect(ticksToMs(2_005_000_000)).toBe(200_500);
    expect(ticksToMs(undefined)).toBe(0);
    expect(msToTicks(1500)).toBe(15_000_000);
    expect(msToTicks(-5)).toBe(0);
  });
});

describe("mapping", () => {
  it("maps a rich audio item", () => {
    const t = mapTrack("s", richTrack);
    expect(t).toMatchObject({
      id: "t1",
      serverId: "s",
      title: "Song",
      artists: [
        { id: "ar1", name: "A" },
        { id: "ar2", name: "B" },
      ],
      artistLine: "A, B",
      albumArtists: [{ id: "ar1", name: "A" }],
      album: { id: "al1", name: "Alb" },
      durationMs: 200_500,
      trackNumber: 3,
      discNumber: 2,
      year: 2020,
      genres: ["Rock", "Pop"],
      cover: "t1:trktag",
      format: {
        container: "flac",
        codec: "flac",
        bitRate: 900,
        sampleRate: 96000,
        bitDepth: 24,
        channels: 2,
        sizeBytes: 1234,
      },
      replayGain: { trackGain: -6.5 },
      starred: true,
      playCount: 7,
      lastPlayedAt: "2024-06-01T10:00:00Z",
      musicBrainzId: "mbid-1",
    });
  });

  it("falls back to the album cover, the file bitrate and plain artist names", () => {
    const t = mapTrack("s", {
      ...richTrack,
      ImageTags: {},
      ArtistItems: [],
      MediaSources: [{ Container: "mov,mp4,m4a,3gp,3g2,mj2", Bitrate: 256_000, MediaStreams: [] }],
    });
    expect(t.cover).toBe("al1:albtag");
    expect(t.artists).toEqual([{ name: "A" }, { name: "B" }]);
    expect(t.format).toEqual({ container: "m4a", bitRate: 256 });
    expect(mapTrack("s", { ...richTrack, ImageTags: {}, AlbumPrimaryImageTag: null }).cover).toBeUndefined();
  });

  it("copes with sparse input and keeps playlist entry ids", () => {
    expect(mapTrack("s", { Id: "x" })).toMatchObject({
      title: "",
      artists: [],
      artistLine: "",
      albumArtists: [],
      durationMs: 0,
      genres: [],
      format: {},
      starred: false,
    });
    expect(mapTrack("s", { Id: "x" }).replayGain).toBeUndefined();
    expect(mapTrack("s", { Id: "x", PlaylistItemId: "entry-1" }).playlistEntryId).toBe("entry-1");
    expect(mapTrack("s", { Id: "x", NormalizationGain: 0 }).replayGain).toEqual({ trackGain: 0 });
  });

  it("normalizes ffmpeg container lists", () => {
    expect(normalizeContainer("mov,mp4,m4a,3gp,3g2,mj2")).toBe("m4a");
    expect(normalizeContainer("FLAC")).toBe("flac");
    expect(normalizeContainer("matroska,webm")).toBe("matroska");
    expect(normalizeContainer(undefined)).toBeUndefined();
  });

  it("maps albums, artists and playlists", () => {
    const album = mapAlbum("s", {
      Id: "al1",
      Name: "Alb",
      AlbumArtist: "A",
      AlbumArtists: [{ Id: "ar1", Name: "A" }],
      ProductionYear: 2018,
      Genres: ["Jazz"],
      ChildCount: 9,
      RunTimeTicks: 1_760_000_000,
      DateCreated: "2024-01-01T00:00:00Z",
      ImageTags: { Primary: "tg" },
      UserData: { IsFavorite: true, PlayCount: 0 },
    });
    expect(album).toMatchObject({
      id: "al1",
      artists: [{ id: "ar1", name: "A" }],
      artistLine: "A",
      year: 2018,
      trackCount: 9,
      durationMs: 176_000,
      addedAt: "2024-01-01T00:00:00Z",
      cover: "al1:tg",
      starred: true,
    });
    expect(mapArtist("s", { Id: "ar1", Name: "A", AlbumCount: 3 })).toEqual({
      id: "ar1",
      serverId: "s",
      name: "A",
      albumCount: 3,
      starred: false,
    });
    expect(mapPlaylist("s", { Id: "p", Name: "P", ChildCount: 4, RunTimeTicks: 10_000 })).toMatchObject({
      public: false,
      readOnly: false,
      trackCount: 4,
      durationMs: 1,
    });
  });
});

describe("browsing", () => {
  it("sends the Authorization header with the token and no credentials in the URL", async () => {
    const provider = await connectProvider();
    mock.respond(() => items());
    await provider.getAlbumList("random");
    expect(lastCall().headers.get("authorization")).toContain(`Token="${SECRET}"`);
    expect(lastCall().url.toString()).not.toContain(SECRET);
    expect(lastCall().url.search).not.toMatch(/api_key/i);
  });

  it("loads an album with its tracks in disc/track order", async () => {
    const provider = await connectProvider();
    mock.respond((call) =>
      call.path === "/Items/al1"
        ? { Id: "al1", Name: "Alb", AlbumArtist: "A", Type: "MusicAlbum" }
        : items(richTrack),
    );
    const album = await provider.getAlbum("al1");
    const query = mock.calls.find((c) => c.path === "/Items")!;
    expect(query.params.get("parentId")).toBe("al1");
    expect(query.params.get("includeItemTypes")).toBe("Audio");
    expect(query.params.get("sortBy")).toBe("ParentIndexNumber,IndexNumber,SortName");
    expect(query.params.get("userId")).toBe("user1");
    expect(query.params.get("fields")).toContain("MediaSources");
    expect(album).toMatchObject({ id: "al1", trackCount: 1, durationMs: 200_500 });
    expect(album.tracks[0]).toMatchObject({ id: "t1", serverId: "srv1" });
  });

  it("loads tracks by id", async () => {
    const provider = await connectProvider();
    mock.respond(() => richTrack);
    expect((await provider.getTrack("t1")).title).toBe("Song");
    expect(lastCall().path).toBe("/Items/t1");
    expect(lastCall().params.get("userId")).toBe("user1");
  });

  it("lists artists via album artists with item counts and pages through large libraries", async () => {
    const provider = await connectProvider();
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({ Id: `a${start + i}`, Name: `A${start + i}`, AlbumCount: 1 }));
    mock.respond((call) =>
      call.params.get("startIndex") === "0"
        ? { Items: page(1000, 0), TotalRecordCount: 1200 }
        : { Items: page(200, 1000), TotalRecordCount: 1200 },
    );
    const artists = await provider.getArtists();
    expect(artists).toHaveLength(1200);
    expect(mock.calls.map((c) => c.path)).toEqual(["/Artists/AlbumArtists", "/Artists/AlbumArtists"]);
    expect(mock.calls[0]!.params.get("fields")).toBe("ItemCounts");
    expect(artists[0]).toMatchObject({ id: "a0", albumCount: 1 });
  });

  it("loads an artist with albums, newest first", async () => {
    const provider = await connectProvider();
    mock.respond((call) =>
      call.path === "/Items/ar1"
        ? { Id: "ar1", Name: "A", ImageTags: { Primary: "tg" }, UserData: { IsFavorite: true } }
        : items(
            { Id: "old", Name: "Old", ProductionYear: 2001 },
            { Id: "none", Name: "No year" },
            { Id: "new", Name: "New", ProductionYear: 2020 },
          ),
    );
    const artist = await provider.getArtist("ar1");
    const query = mock.calls.find((c) => c.path === "/Items")!;
    expect(query.params.get("albumArtistIds")).toBe("ar1");
    expect(query.params.get("includeItemTypes")).toBe("MusicAlbum");
    expect(artist).toMatchObject({ id: "ar1", cover: "ar1:tg", starred: true, albumCount: 3 });
    expect(artist.albums.map((a) => a.id)).toEqual(["new", "old", "none"]);
  });

  it("builds artist info from the overview, image and similar artists", async () => {
    const provider = await connectProvider();
    mock.respond((call) =>
      call.path === "/Artists/ar1/Similar"
        ? items({ Id: "ar2", Name: "Similar" })
        : {
            Id: "ar1",
            Name: "A",
            Overview: "Bio text",
            ImageTags: { Primary: "tg" },
            ExternalUrls: [{ Name: "MusicBrainz Artist", Url: "https://musicbrainz.org/artist/x" }],
          },
    );
    const info = await provider.getArtistInfo("ar1");
    expect(info).toMatchObject({
      biography: "Bio text",
      externalUrl: "https://musicbrainz.org/artist/x",
      similarArtists: [{ id: "ar2", name: "Similar" }],
    });
    expect(info!.imageUrl).toContain("/Items/ar1/Images/Primary");
    expect(info!.imageUrl).toContain("tag=tg");
    expect(info!.imageUrl).not.toContain(SECRET);
    expect(mock.calls.find((c) => c.path === "/Artists/ar1/Similar")!.params.get("userId")).toBe("user1");
  });

  it("returns null artist info when there is nothing to show and tolerates a missing similar endpoint", async () => {
    const provider = await connectProvider();
    mock.respond((call) => (call.path === "/Items/ar1" ? { Id: "ar1", Name: "A", Overview: "  " } : undefined));
    expect(await provider.getArtistInfo("ar1")).toBeNull();
  });

  it("finds top tracks by artist id, sorted by play count", async () => {
    const provider = await connectProvider();
    mock.respond(() => items(richTrack));
    const tracks = await provider.getTopTracks({ id: "ar1", name: "A" }, 5);
    expect(tracks).toHaveLength(1);
    expect(lastCall().params.get("artistIds")).toBe("ar1");
    expect(lastCall().params.get("sortBy")).toBe("PlayCount,SortName");
    expect(lastCall().params.get("sortOrder")).toBe("Descending");
    expect(lastCall().params.get("limit")).toBe("5");
  });

  it("resolves a top-track artist by name when there is no id", async () => {
    const provider = await connectProvider();
    mock.respond((call) =>
      call.path === "/Artists" ? items({ Id: "x", Name: "Other" }, { Id: "ar9", Name: "a" }) : items(richTrack),
    );
    await provider.getTopTracks({ name: "A" });
    expect(lastCall().params.get("artistIds")).toBe("ar9");
    mock.respond(() => items());
    expect(await provider.getTopTracks({ name: "Nobody" })).toEqual([]);
  });

  it("builds similar tracks from the instant mix without the seed track", async () => {
    const provider = await connectProvider();
    mock.respond(() => items({ ...richTrack, Id: "t1" }, { ...richTrack, Id: "t2" }, { ...richTrack, Id: "t3" }));
    const tracks = await provider.getSimilarTracks("t1", 2);
    expect(lastCall().path).toBe("/Items/t1/InstantMix");
    expect(lastCall().params.get("limit")).toBe("3");
    expect(tracks.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("requests random tracks and tracks by genre", async () => {
    const provider = await connectProvider();
    mock.respond(() => items(richTrack));
    await provider.getRandomTracks({ size: 7, genre: "Rock, Pop", fromYear: 1999, toYear: 2001 });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      includeItemTypes: "Audio",
      sortBy: "Random",
      limit: "7",
      genres: "Rock, Pop",
      years: "1999,2000,2001",
    });
    await provider.getTracksByGenre("Jazz", { size: 10, offset: 20 });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      genres: "Jazz",
      limit: "10",
      startIndex: "20",
    });
  });

  it("lists genres with counts", async () => {
    const provider = await connectProvider();
    mock.respond(() => items({ Id: "g", Name: "Jazz", SongCount: 12, AlbumCount: 2 }, { Id: "h", Name: "Pop" }));
    expect(await provider.getGenres()).toEqual([{ name: "Jazz", trackCount: 12, albumCount: 2 }, { name: "Pop" }]);
    expect(lastCall().path).toBe("/MusicGenres");
  });

  it("searches artists, albums and tracks, skipping categories with limit 0", async () => {
    const provider = await connectProvider();
    mock.respond((call) => {
      if (call.path === "/Artists") return items({ Id: "ar1", Name: "A" });
      return call.params.get("includeItemTypes") === "MusicAlbum"
        ? items({ Id: "al1", Name: "Alb" })
        : items(richTrack);
    });
    const result = await provider.search("son", { artists: 3, albums: 4, tracks: 5, offset: 10 });
    expect(result.artists.map((a) => a.id)).toEqual(["ar1"]);
    expect(result.albums.map((a) => a.id)).toEqual(["al1"]);
    expect(result.tracks.map((t) => t.id)).toEqual(["t1"]);
    expect(mock.calls).toHaveLength(3);
    for (const call of mock.calls) {
      expect(call.params.get("searchTerm")).toBe("son");
      expect(call.params.get("startIndex")).toBe("10");
    }
    mock.calls.length = 0;
    const onlyTracks = await provider.search("x", { artists: 0, albums: 0 });
    expect(onlyTracks.artists).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("getAlbumList", () => {
  it.each([
    ["recentlyAdded", { sortBy: "DateCreated,SortName", sortOrder: "Descending" }],
    ["random", { sortBy: "Random" }],
    ["alphabeticalByName", { sortBy: "SortName", sortOrder: "Ascending" }],
    ["alphabeticalByArtist", { sortBy: "AlbumArtist,SortName", sortOrder: "Ascending" }],
    ["highestRated", { sortBy: "CommunityRating,SortName", sortOrder: "Descending" }],
    ["starred", { isFavorite: "true" }],
  ] as const)("maps %s to its query", async (type, expected) => {
    const provider = await connectProvider();
    mock.respond(() => items());
    await provider.getAlbumList(type);
    expect(lastCall().path).toBe("/Items");
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      includeItemTypes: "MusicAlbum",
      recursive: "true",
      userId: "user1",
      limit: "50",
      startIndex: "0",
      ...expected,
    });
  });

  it("filters by genre and year range and passes size/offset (size capped at 500)", async () => {
    const provider = await connectProvider();
    mock.respond(() => items());
    await provider.getAlbumList("byGenre", { genre: "Hip-Hop", size: 9999, offset: 10 });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({ genres: "Hip-Hop", limit: "500", startIndex: "10" });
    await provider.getAlbumList("byYear", { fromYear: 1990, toYear: 1993 });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      years: "1990,1991,1992,1993",
      sortBy: "ProductionYear,SortName",
      sortOrder: "Ascending",
    });
    await provider.getAlbumList("byYear", { fromYear: 1993, toYear: 1990 });
    expect(lastCall().params.get("years")).toBe("1990,1991,1992,1993");
    expect(lastCall().params.get("sortOrder")).toBe("Descending");
  });

  it("derives recently played albums from played tracks, most recent first", async () => {
    const provider = await connectProvider();
    mock.respond((call) => {
      if (call.params.get("includeItemTypes") === "Audio") {
        return items(
          { Id: "t1", AlbumId: "alB" },
          { Id: "t2", AlbumId: "alA" },
          { Id: "t3", AlbumId: "alB" },
          { Id: "t4" },
        );
      }
      // The server answers in its own order.
      return items({ Id: "alA", Name: "A" }, { Id: "alB", Name: "B" });
    });
    const albums = await provider.getAlbumList("recentlyPlayed", { size: 10 });
    expect(albums.map((a) => a.id)).toEqual(["alB", "alA"]);
    const trackQuery = mock.calls[0]!;
    expect(trackQuery.params.get("filters")).toBe("IsPlayed");
    expect(trackQuery.params.get("sortBy")).toBe("DatePlayed");
    expect(trackQuery.params.get("sortOrder")).toBe("Descending");
    expect(mock.calls[1]!.params.get("ids")).toBe("alB,alA");
  });

  it("ranks most played albums by summed play counts and pages the result", async () => {
    const provider = await connectProvider();
    const played = (id: string, album: string, count: number): WireItem => ({
      Id: id,
      AlbumId: album,
      UserData: { PlayCount: count },
    });
    mock.respond((call) =>
      call.params.get("includeItemTypes") === "Audio"
        ? items(played("t1", "alA", 9), played("t2", "alB", 5), played("t3", "alB", 5), played("t4", "alC", 1))
        : items({ Id: "alC", Name: "C" }, { Id: "alA", Name: "A" }),
    );
    const albums = await provider.getAlbumList("mostPlayed", { size: 2, offset: 1 });
    expect(mock.calls[0]!.params.get("sortBy")).toBe("PlayCount");
    // alB (10) beats alA (9) beats alC (1); offset 1 skips the first.
    expect(mock.calls[1]!.params.get("ids")).toBe("alA,alC");
    expect(albums.map((a) => a.id)).toEqual(["alA", "alC"]);
  });

  it("returns an empty list without a second request when nothing was played", async () => {
    const provider = await connectProvider();
    mock.respond(() => items());
    expect(await provider.getAlbumList("recentlyPlayed")).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("favorites", () => {
  it("lists favorite tracks, albums and artists", async () => {
    const provider = await connectProvider();
    mock.respond((call) => {
      if (call.path === "/Artists") return items({ Id: "ar1", Name: "A", UserData: { IsFavorite: true } });
      return call.params.get("includeItemTypes") === "MusicAlbum"
        ? items({ Id: "al1", Name: "Alb", UserData: { IsFavorite: true } })
        : items(richTrack);
    });
    const starred = await provider.getStarred();
    expect(starred.tracks).toHaveLength(1);
    expect(starred.albums[0]).toMatchObject({ id: "al1", starred: true });
    expect(starred.artists[0]).toMatchObject({ id: "ar1", starred: true });
    for (const call of mock.calls) expect(call.params.get("isFavorite")).toBe("true");
  });

  it("sets and clears favorites", async () => {
    const provider = await connectProvider();
    mock.respond(() => ({ IsFavorite: true }));
    await provider.setStarred("track", "t1", true);
    expect(lastCall()).toMatchObject({ method: "POST", path: "/UserFavoriteItems/t1" });
    expect(lastCall().params.get("userId")).toBe("user1");
    await provider.setStarred("album", "al1", false);
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/UserFavoriteItems/al1" });
  });
});

describe("playlists", () => {
  const entry = (id: string, entryId = `e-${id}`): WireItem => ({ ...richTrack, Id: id, PlaylistItemId: entryId });
  const asTracks = (...list: WireItem[]): Track[] => list.map((i) => mapTrack("srv1", i));
  const isMove = (c: JellyfinCall) => c.path.includes("/Move/");

  it("lists playlists", async () => {
    const provider = await connectProvider();
    mock.respond(() =>
      items({ Id: "p1", Name: "Mix", ChildCount: 3, RunTimeTicks: 30_000_000, DateCreated: "2025-02-02T00:00:00Z" }),
    );
    const list = await provider.getPlaylists();
    expect(lastCall().params.get("includeItemTypes")).toBe("Playlist");
    expect(list).toEqual([
      {
        id: "p1",
        serverId: "srv1",
        name: "Mix",
        public: false,
        trackCount: 3,
        durationMs: 3000,
        readOnly: false,
        createdAt: "2025-02-02T00:00:00Z",
      },
    ]);
  });

  it("loads a playlist with entry ids, public flag and edit rights", async () => {
    const provider = await connectProvider();
    mock.respond((call) => {
      if (call.path === "/Playlists/p1/Items") return items(entry("t1"), entry("t1", "e-dup"));
      if (call.path === "/Playlists/p1") return { OpenAccess: true, Shares: [{ UserId: "user1", CanEdit: false }] };
      return { Id: "p1", Name: "Mix", CanDelete: true };
    });
    const playlist = await provider.getPlaylist("p1");
    expect(playlist).toMatchObject({ id: "p1", name: "Mix", public: true, readOnly: true, trackCount: 2 });
    expect(playlist.tracks.map((t) => t.playlistEntryId)).toEqual(["e-t1", "e-dup"]);
  });

  it("treats a playlist whose sharing info is forbidden as read-only", async () => {
    const provider = await connectProvider();
    mock.respond((call) => {
      if (call.path === "/Playlists/p1/Items") return items(entry("t1"));
      if (call.path === "/Playlists/p1") return status(403);
      return { Id: "p1", Name: "Mix" };
    });
    expect(await provider.getPlaylist("p1")).toMatchObject({ readOnly: true, public: false });
  });

  it("creates a playlist as Audio with the given tracks", async () => {
    const provider = await connectProvider();
    mock.respond((call) =>
      call.method === "POST" ? { Id: "new1" } : { Id: "new1", Name: "Fresh", ChildCount: 2 },
    );
    const playlist = await provider.createPlaylist("Fresh", ["t1", "t2"]);
    expect(mock.calls[0]!.body).toEqual({
      Name: "Fresh",
      Ids: ["t1", "t2"],
      UserId: "user1",
      MediaType: "Audio",
      IsPublic: false,
    });
    expect(playlist).toMatchObject({ id: "new1", name: "Fresh", trackCount: 2, public: false });
  });

  it("renames and changes visibility; descriptions are unsupported", async () => {
    const provider = await connectProvider();
    mock.respond(() => noContent());
    await provider.updatePlaylist("p1", { name: "New", public: true });
    expect(lastCall()).toMatchObject({ method: "POST", path: "/Playlists/p1", body: { Name: "New", IsPublic: true } });
    await provider.updatePlaylist("p1", { public: false });
    expect(lastCall().body).toEqual({ IsPublic: false });
    mock.calls.length = 0;
    await expect(provider.updatePlaylist("p1", { comment: "x" })).rejects.toMatchObject({ kind: "unsupported" });
    expect(mock.calls).toHaveLength(0);
  });

  it("adds tracks in chunks of 100, keeping their order", async () => {
    const provider = await connectProvider();
    mock.respond(() => noContent());
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
    await provider.addToPlaylist("p1", ids);
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.every((c) => c.method === "POST" && c.path === "/Playlists/p1/Items")).toBe(true);
    expect(mock.calls.flatMap((c) => c.params.get("ids")!.split(","))).toEqual(ids);
    expect(mock.calls[0]!.params.get("userId")).toBe("user1");
    mock.calls.length = 0;
    await provider.addToPlaylist("p1", []);
    expect(mock.calls).toHaveLength(0);
  });

  it("removes entries by position through their entry ids", async () => {
    const provider = await connectProvider();
    mock.respond((call) => (call.method === "GET" ? items(entry("a"), entry("b"), entry("c")) : noContent()));
    await provider.removeFromPlaylist("p1", [2, 0, 9]);
    expect(mock.calls[0]).toMatchObject({ method: "GET", path: "/Playlists/p1/Items" });
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/Playlists/p1/Items" });
    expect(lastCall().params.get("entryIds")).toBe("e-c,e-a");
  });

  it("deletes a playlist", async () => {
    const provider = await connectProvider();
    mock.respond(() => noContent());
    await provider.deletePlaylist("p1");
    expect(lastCall()).toMatchObject({ method: "DELETE", path: "/Items/p1" });
  });

  describe("reorder", () => {
    const current = [entry("a"), entry("b"), entry("c"), entry("d")];

    it("moves only what is needed", async () => {
      const provider = await connectProvider();
      mock.respond((call) => (call.method === "GET" ? items(...current) : noContent()));
      // a,b,c,d -> b,c,d,a : one move.
      await provider.reorderPlaylist("p1", asTracks(current[1]!, current[2]!, current[3]!, current[0]!));
      const moves = mock.calls.filter(isMove);
      expect(moves.map((m) => [m.method, m.path])).toEqual([["POST", "/Playlists/p1/Items/e-a/Move/3"]]);
      expect(mock.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    });

    it("issues exact moves for a full reversal", async () => {
      const provider = await connectProvider();
      mock.respond((call) => (call.method === "GET" ? items(...current) : noContent()));
      await provider.reorderPlaylist("p1", asTracks(current[3]!, current[2]!, current[1]!, current[0]!));
      expect(mock.calls.filter(isMove).map((m) => m.path)).toEqual([
        "/Playlists/p1/Items/e-d/Move/0",
        "/Playlists/p1/Items/e-c/Move/1",
        "/Playlists/p1/Items/e-b/Move/2",
      ]);
    });

    it("does nothing when the order is unchanged", async () => {
      const provider = await connectProvider();
      mock.respond((call) => (call.method === "GET" ? items(...current) : noContent()));
      await provider.reorderPlaylist("p1", asTracks(...current));
      expect(mock.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("rebuilds the playlist when a move fails", async () => {
      const provider = await connectProvider();
      mock.respond((call) => {
        if (call.method === "GET") return items(...current);
        return isMove(call) ? status(500) : noContent();
      });
      await provider.reorderPlaylist("p1", asTracks(current[1]!, current[0]!, current[2]!, current[3]!));
      const after = mock.calls.slice(mock.calls.findIndex(isMove) + 1);
      expect(after.map((c) => `${c.method} ${c.path}`)).toEqual([
        "DELETE /Playlists/p1/Items",
        "POST /Playlists/p1/Items",
      ]);
      expect(after[0]!.params.get("entryIds")).toBe("e-a,e-b,e-c,e-d");
      expect(after[1]!.params.get("ids")).toBe("b,a,c,d");
    });

    it("rebuilds directly when tracks carry no entry ids or the playlist changed meanwhile", async () => {
      const provider = await connectProvider();
      mock.respond((call) => (call.method === "GET" ? items(...current) : noContent()));
      const withoutEntries = asTracks(current[1]!, current[0]!).map(({ playlistEntryId: _e, ...rest }) => rest);
      await provider.reorderPlaylist("p1", withoutEntries as Track[]);
      expect(mock.calls.filter(isMove)).toHaveLength(0);
      expect(mock.calls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST"]);
      expect(lastCall().params.get("ids")).toBe("b,a");
    });
  });
});

describe("planPlaylistMoves", () => {
  const apply = (current: string[], moves: { entryId: string; newIndex: number }[]) => {
    const work = [...current];
    for (const m of moves) {
      work.splice(work.indexOf(m.entryId), 1);
      work.splice(m.newIndex, 0, m.entryId);
    }
    return work;
  };

  it("computes minimal moves for simple cases", () => {
    expect(planPlaylistMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(planPlaylistMoves(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual([{ entryId: "a", newIndex: 3 }]);
    expect(planPlaylistMoves(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual([{ entryId: "d", newIndex: 0 }]);
    expect(planPlaylistMoves(["a", "b", "c", "d", "e"], ["e", "d", "c", "b", "a"])).toEqual([
      { entryId: "e", newIndex: 0 },
      { entryId: "d", newIndex: 1 },
      { entryId: "c", newIndex: 2 },
      { entryId: "b", newIndex: 3 },
    ]);
  });

  it("always reaches the target order for random permutations", () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 300; round++) {
      const size = 1 + Math.floor(random() * 14);
      const current = Array.from({ length: size }, (_, i) => `e${i}`);
      const target = [...current].sort(() => random() - 0.5);
      const moves = planPlaylistMoves(current, target);
      expect(apply(current, moves)).toEqual(target);
      expect(moves.length).toBeLessThanOrEqual(Math.max(0, size - 1));
    }
  });
});

describe("lyrics", () => {
  const track = mapTrack("srv1", richTrack);

  it("maps synced lyrics (ticks to ms) with word cues", async () => {
    const provider = await connectProvider();
    mock.respond(() => ({
      Metadata: { IsSynced: true, Offset: 2_500_000 },
      Lyrics: [
        {
          Text: "Hello world",
          Start: 30_000_000,
          Cues: [
            { Position: 0, EndPosition: 5, Start: 30_000_000, End: 33_000_000 },
            { Position: 6, EndPosition: 11, Start: 33_500_000, End: 36_000_000 },
          ],
        },
        { Text: "", Start: 62_500_000, Cues: [] },
        { Text: "Second line", Start: 95_000_000 },
      ],
    }));
    const lyrics = await provider.getLyrics(track);
    expect(lastCall().path).toBe("/Audio/t1/Lyrics");
    expect(lyrics).toEqual({
      synced: true,
      offsetMs: 250,
      source: "server",
      lines: [
        {
          text: "Hello world",
          startMs: 3000,
          words: [
            { startMs: 3000, endMs: 3300, text: "Hello" },
            { startMs: 3350, endMs: 3600, text: "world" },
          ],
        },
        { text: "", startMs: 6250 },
        { text: "Second line", startMs: 9500 },
      ],
    });
  });

  it("maps unsynced lyrics without times", async () => {
    const provider = await connectProvider();
    mock.respond(() => ({ Metadata: {}, Lyrics: [{ Text: "One" }, { Text: "  " }, { Text: "Two", Start: null }] }));
    expect(await provider.getLyrics(track)).toEqual({
      synced: false,
      offsetMs: 0,
      source: "server",
      lines: [{ text: "One" }, { text: "" }, { text: "Two" }],
    });
  });

  it("derives cue text from the next cue when end positions are missing", () => {
    const lyrics = mapLyrics({
      Lyrics: [
        {
          Text: "ab cd",
          Start: 10_000,
          Cues: [
            { Position: 0, Start: 10_000 },
            { Position: 3, Start: 20_000 },
          ],
        },
      ],
    });
    expect(lyrics!.lines[0]!.words).toEqual([
      { startMs: 1, text: "ab " },
      { startMs: 2, text: "cd" },
    ]);
  });

  it("returns null for 404 and for empty lyrics, and rethrows other errors", async () => {
    const provider = await connectProvider();
    mock.respond(() => undefined);
    expect(await provider.getLyrics(track)).toBeNull();
    mock.respond(() => ({ Metadata: {}, Lyrics: [] }));
    expect(await provider.getLyrics(track)).toBeNull();
    mock.respond(() => status(500));
    await expect(provider.getLyrics(track)).rejects.toMatchObject({ kind: "server", code: 500 });
  });
});

describe("media", () => {
  const track = mapTrack("srv1", richTrack);

  it("streams the original file statically, authenticating through headers", async () => {
    const provider = await connectProvider();
    const source = provider.getStreamSource(track);
    const url = new URL(source.url);
    expect(url.origin + url.pathname).toBe("https://jf.test/Audio/t1/stream");
    expect(Object.fromEntries(url.searchParams)).toEqual({ static: "true", mediaSourceId: "t1" });
    expect(source.headers.Authorization).toMatch(/^MediaBrowser .*, Token="secret-token-xyz"$/);
    expect(source.cacheKey).toBe("srv1:t1:raw:0");
    expect(source).toMatchObject({ transcoded: false, container: "flac" });
    expect(source.timeOffset).toBeUndefined();
    expect(source.url).not.toContain(SECRET);
    expect(source.cacheKey).not.toContain(SECRET);
    expect(mock.calls).toHaveLength(0);
  });

  it("transcodes through the universal endpoint when a bitrate limit is set", async () => {
    const provider = await connectProvider();
    const source = provider.getStreamSource(track, { maxBitRateKbps: 128, format: "opus" });
    const url = new URL(source.url);
    expect(url.pathname).toBe("/Audio/t1/universal");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      userId: "user1",
      audioCodec: "opus",
      transcodingContainer: "ogg",
      transcodingProtocol: "http",
      audioBitRate: "128000",
      maxStreamingBitrate: "128000",
    });
    expect(url.searchParams.has("container")).toBe(false);
    expect(source).toMatchObject({
      transcoded: true,
      container: "ogg",
      cacheKey: "srv1:t1:opus:128",
      timeOffset: { param: "startTimeTicks", unit: "ticks" },
    });
    expect(source.headers.Authorization).toContain(`Token="${SECRET}"`);
    expect(source.url).not.toContain(SECRET);
    expect(source.cacheKey).not.toContain(SECRET);
  });

  it("defaults transcodes to mp3 and treats 0 kbps as original quality", async () => {
    const provider = await connectProvider();
    const mp3 = provider.getStreamSource(track, { maxBitRateKbps: 192 });
    expect(new URL(mp3.url).searchParams.get("audioCodec")).toBe("mp3");
    expect(mp3.cacheKey).toBe("srv1:t1:mp3:192");
    expect(provider.getStreamSource(track, { maxBitRateKbps: 0 }).transcoded).toBe(false);
  });

  it("downloads the original file or a transcode", async () => {
    const provider = await connectProvider();
    const original = provider.getDownloadSource(track);
    expect(original.url).toBe("https://jf.test/Items/t1/Download");
    expect(original).toMatchObject({ transcoded: false, cacheKey: "srv1:t1:raw:0" });
    expect(original.headers.Authorization).toContain(`Token="${SECRET}"`);
    const transcode = provider.getDownloadSource(track, { maxBitRateKbps: 96, format: "aac" });
    expect(new URL(transcode.url).pathname).toBe("/Audio/t1/universal");
    expect(transcode).toMatchObject({ transcoded: true, cacheKey: "srv1:t1:aac:96" });
  });

  it("builds credential-free cover URLs", async () => {
    const provider = await connectProvider();
    const url = new URL(provider.coverUrl("al1:tg", 300));
    expect(url.pathname).toBe("/Items/al1/Images/Primary");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fillWidth: "300",
      fillHeight: "300",
      quality: "90",
      tag: "tg",
    });
    expect(provider.coverUrl("al1")).toBe("https://jf.test/Items/al1/Images/Primary?quality=90");
    expect(provider.coverUrl("al1:tg")).not.toContain(SECRET);
  });
});

describe("reporting", () => {
  it("reports start, progress and stop with positions in ticks", async () => {
    const provider = await connectProvider();
    mock.respond(() => noContent());
    await provider.reportPlayback({ type: "start", trackId: "t1", positionMs: 0 });
    expect(lastCall()).toMatchObject({
      method: "POST",
      path: "/Sessions/Playing",
      body: { ItemId: "t1", MediaSourceId: "t1", PositionTicks: 0, CanSeek: true },
    });
    await provider.reportPlayback({ type: "progress", trackId: "t1", positionMs: 12_345, paused: true });
    expect(lastCall()).toMatchObject({
      path: "/Sessions/Playing/Progress",
      body: { ItemId: "t1", PositionTicks: 123_450_000, IsPaused: true },
    });
    await provider.reportPlayback({ type: "stop", trackId: "t1", positionMs: 200_500 });
    expect(lastCall()).toMatchObject({
      method: "POST",
      path: "/Sessions/Playing/Stopped",
      body: { ItemId: "t1", MediaSourceId: "t1", PositionTicks: 2_005_000_000 },
    });
    expect(mock.calls).toHaveLength(3);
  });

  it("ignores scrobbles because Jellyfin counts plays on stop", async () => {
    const provider = await connectProvider();
    await provider.reportPlayback({ type: "scrobble", trackId: "t1", playedAt: new Date() });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("error mapping", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "notFound"],
    [500, "server"],
  ] as const)("maps HTTP %i to %s", async (code, kind) => {
    const provider = await connectProvider();
    mock.respond(() => status(code));
    await expect(provider.getAlbum("al1")).rejects.toMatchObject({ kind, code });
  });

  it("does not leak the token into error messages", async () => {
    const provider = await connectProvider();
    mock.respond(() => status(500));
    const error = await provider.getTrack("t1").catch((e: Error) => e);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

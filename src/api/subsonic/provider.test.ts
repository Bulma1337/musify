import { subsonicFailed, subsonicOk, setupMockServer, type RecordedCall } from "@/test/msw";
import type { MusicProvider, ServerConfig, Track } from "../provider";
import { subsonicFactory } from ".";
import { mapTrack } from "./mappers";
import type { WireChild } from "./wire";

const mock = setupMockServer();

const baseServer: ServerConfig = {
  id: "srv1",
  kind: "subsonic",
  name: "Test",
  url: "https://music.test",
  username: "bob",
  authMode: "token",
  addedAt: "2025-01-01T00:00:00Z",
};

interface Setup {
  type?: string;
  extensions?: { name: string; versions: number[] }[];
  server?: Partial<ServerConfig>;
  secret?: string;
}

/** Connects a provider against the mock; later `mock.respond` calls replace the connect-time responder. */
async function connectProvider(setup: Setup = {}): Promise<MusicProvider> {
  mock.respond((call) =>
    call.endpoint === "getOpenSubsonicExtensions"
      ? subsonicOk({ openSubsonicExtensions: setup.extensions ?? [] })
      : subsonicOk({}, { type: setup.type ?? "navidrome" }),
  );
  const provider = await subsonicFactory.connect({ ...baseServer, ...setup.server }, setup.secret ?? "pw");
  mock.calls.length = 0;
  return provider;
}

const child: WireChild = {
  id: "t1",
  title: "Song",
  artist: "A",
  artistId: "ar1",
  album: "Alb",
  albumId: "al1",
  duration: 200.5,
  suffix: "flac",
};

const lastCall = (): RecordedCall => mock.calls[mock.calls.length - 1]!;

describe("mapping", () => {
  it("maps a rich OpenSubsonic child", () => {
    const t = mapTrack("s", {
      ...child,
      artists: [
        { id: "ar1", name: "A" },
        { id: "ar2", name: "B" },
      ],
      displayArtist: "A feat. B",
      albumArtists: [{ id: "ar1", name: "A" }],
      track: 3,
      discNumber: 2,
      year: 2020,
      genres: [{ name: "Rock" }, { name: "Pop" }],
      coverArt: "al-al1",
      bitRate: 900,
      samplingRate: 96000,
      bitDepth: 24,
      channelCount: 2,
      size: 1234,
      replayGain: { trackGain: -6.5, albumGain: -7, trackPeak: 0.98, albumPeak: 1 },
      explicitStatus: "explicit",
      starred: "2024-05-01T10:00:00Z",
      playCount: 7,
      played: "2024-06-01T10:00:00Z",
      userRating: 4,
      bpm: 120,
      musicBrainzId: "mbid",
    });
    expect(t).toMatchObject({
      id: "t1",
      serverId: "s",
      durationMs: 200500,
      artistLine: "A feat. B",
      artists: [
        { id: "ar1", name: "A" },
        { id: "ar2", name: "B" },
      ],
      album: { id: "al1", name: "Alb" },
      trackNumber: 3,
      discNumber: 2,
      genres: ["Rock", "Pop"],
      cover: "al-al1",
      format: {
        container: "flac",
        bitRate: 900,
        sampleRate: 96000,
        bitDepth: 24,
        channels: 2,
        sizeBytes: 1234,
      },
      replayGain: { trackGain: -6.5, albumGain: -7, trackPeak: 0.98, albumPeak: 1 },
      explicit: true,
      starred: true,
      starredAt: "2024-05-01T10:00:00Z",
      playCount: 7,
      lastPlayedAt: "2024-06-01T10:00:00Z",
      rating: 4,
      bpm: 120,
      musicBrainzId: "mbid",
    });
  });

  it("falls back for legacy children and never crashes on sparse input", () => {
    const t = mapTrack("s", { ...child, genre: "Jazz", explicitStatus: "clean" });
    expect(t.artists).toEqual([{ id: "ar1", name: "A" }]);
    expect(t.artistLine).toBe("A");
    expect(t.genres).toEqual(["Jazz"]);
    expect(t.explicit).toBe(false);
    expect(t.starred).toBe(false);
    expect(t.replayGain).toBeUndefined();
    expect(mapTrack("s", { id: "x" })).toMatchObject({
      title: "",
      artists: [],
      artistLine: "",
      durationMs: 0,
    });
    expect(mapTrack("s", { ...child, explicitStatus: "notSupported" }).explicit).toBeUndefined();
  });

  it("maps albums with disc titles and release types", async () => {
    const provider = await connectProvider();
    mock.respond(() =>
      subsonicOk({
        album: {
          id: "al1",
          name: "Alb",
          artist: "A",
          artistId: "ar1",
          year: 2020,
          songCount: 1,
          duration: 200,
          created: "2024-01-01T00:00:00Z",
          releaseTypes: ["EP", "compilation"],
          discTitles: [{ disc: 1, title: "First" }],
          song: [child],
        },
      }),
    );
    const album = await provider.getAlbum("al1");
    expect(lastCall().params.get("id")).toBe("al1");
    expect(album).toMatchObject({
      serverId: "srv1",
      artists: [{ id: "ar1", name: "A" }],
      artistLine: "A",
      durationMs: 200000,
      addedAt: "2024-01-01T00:00:00Z",
      releaseType: "ep",
      discTitles: { 1: "First" },
    });
    expect(album.tracks).toHaveLength(1);
    expect(album.tracks[0]!.serverId).toBe("srv1");
  });

  it("marks compilations via isCompilation", async () => {
    const provider = await connectProvider();
    mock.respond(() =>
      subsonicOk({
        albumList2: { album: [{ id: "a", name: "VA", isCompilation: true, releaseTypes: ["album"] }] },
      }),
    );
    expect((await provider.getAlbumList("random"))[0]!.releaseType).toBe("compilation");
  });
});

describe("getAlbumList", () => {
  it.each([
    ["recentlyPlayed", "recent"],
    ["recentlyAdded", "newest"],
    ["mostPlayed", "frequent"],
    ["random", "random"],
    ["starred", "starred"],
    ["alphabeticalByName", "alphabeticalByName"],
    ["alphabeticalByArtist", "alphabeticalByArtist"],
    ["highestRated", "highest"],
  ] as const)("maps %s to %s", async (type, wire) => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk({ albumList2: { album: [] } }));
    await provider.getAlbumList(type);
    const call = lastCall();
    expect(call.endpoint).toBe("getAlbumList2");
    expect(call.params.get("type")).toBe(wire);
    expect(call.params.get("size")).toBe("50");
  });

  it("passes year, genre, size and offset, and caps size at 500", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk({ albumList2: { album: [] } }));
    await provider.getAlbumList("byYear", { fromYear: 1990, toYear: 1999, size: 9999, offset: 10 });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      type: "byYear",
      fromYear: "1990",
      toYear: "1999",
      size: "500",
      offset: "10",
    });
    await provider.getAlbumList("byGenre", { genre: "Rock" });
    expect(lastCall().params.get("genre")).toBe("Rock");
  });
});

describe("playlists", () => {
  const tracks = ["a", "b", "c"].map((id) => mapTrack("srv1", { id }));

  it("replaces the order in one createPlaylist call on Navidrome", async () => {
    const provider = await connectProvider({ type: "navidrome" });
    mock.respond(() => subsonicOk({ playlist: { id: "p1", name: "x" } }));
    await provider.reorderPlaylist("p1", [tracks[2]!, tracks[0]!, tracks[1]!]);
    expect(mock.calls).toHaveLength(1);
    const call = lastCall();
    expect(call.endpoint).toBe("createPlaylist");
    expect(call.params.get("playlistId")).toBe("p1");
    expect(call.params.getAll("songId")).toEqual(["c", "a", "b"]);
    expect(call.params.has("name")).toBe(false);
  });

  it("removes all and re-adds in order on other servers", async () => {
    const provider = await connectProvider({ type: "gonic" });
    mock.respond(() => subsonicOk());
    await provider.reorderPlaylist("p1", [tracks[1]!, tracks[2]!, tracks[0]!]);
    expect(mock.calls).toHaveLength(1);
    const call = lastCall();
    expect(call.endpoint).toBe("updatePlaylist");
    expect(call.params.get("playlistId")).toBe("p1");
    expect(call.params.getAll("songIndexToRemove")).toEqual(["0", "1", "2"]);
    expect(call.params.getAll("songIdToAdd")).toEqual(["b", "c", "a"]);
  });

  it("uses POST for long id lists only when formPost is advertised", async () => {
    const many: Track[] = Array.from({ length: 250 }, (_, i) => mapTrack("srv1", { id: `t${i}` }));
    let provider = await connectProvider({ extensions: [{ name: "formPost", versions: [1] }] });
    mock.respond(() => subsonicOk());
    await provider.reorderPlaylist("p1", many);
    expect(lastCall().method).toBe("POST");
    expect(lastCall().params.getAll("songId")).toHaveLength(250);
    await provider.reorderPlaylist("p1", many.slice(0, 5));
    expect(lastCall().method).toBe("GET");

    provider = await connectProvider();
    mock.respond(() => subsonicOk());
    await provider.reorderPlaylist("p1", many);
    expect(lastCall().method).toBe("GET");
  });

  it("derives readOnly from readonly or owner and sends update params", async () => {
    const provider = await connectProvider();
    mock.respond(() =>
      subsonicOk({
        playlists: {
          playlist: [
            { id: "1", name: "mine", owner: "bob", songCount: 2, duration: 10 },
            { id: "2", name: "theirs", owner: "eve", public: true },
            { id: "3", name: "smart", owner: "bob", readonly: true },
          ],
        },
      }),
    );
    const lists = await provider.getPlaylists();
    expect(lists.map((p) => p.readOnly)).toEqual([false, true, true]);
    expect(lists[0]).toMatchObject({ trackCount: 2, durationMs: 10000, public: false });

    mock.respond(() => subsonicOk());
    await provider.updatePlaylist("1", { name: "n", public: true });
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      playlistId: "1",
      name: "n",
      public: "true",
    });
    await provider.removeFromPlaylist("1", [4, 2]);
    expect(lastCall().params.getAll("songIndexToRemove")).toEqual(["4", "2"]);
    await provider.addToPlaylist("1", ["x", "y"]);
    expect(lastCall().params.getAll("songIdToAdd")).toEqual(["x", "y"]);
  });
});

describe("lyrics", () => {
  const track = mapTrack("srv1", child);

  it("picks the first synced entry and applies offset and language", async () => {
    const provider = await connectProvider({ extensions: [{ name: "songLyrics", versions: [1] }] });
    mock.respond(() =>
      subsonicOk({
        lyricsList: {
          structuredLyrics: [
            { lang: "eng", synced: false, line: [{ value: "plain" }] },
            {
              lang: "xxx",
              synced: true,
              offset: -250,
              line: [
                { start: 1000, value: "one" },
                { start: 2500, value: "  " },
              ],
            },
          ],
        },
      }),
    );
    const lyrics = await provider.getLyrics(track);
    expect(lastCall().endpoint).toBe("getLyricsBySongId");
    expect(lastCall().params.has("enhanced")).toBe(false);
    expect(lyrics).toEqual({
      synced: true,
      offsetMs: -250,
      source: "server",
      lines: [
        { startMs: 1000, text: "one" },
        { startMs: 2500, text: "" },
      ],
    });
  });

  it("requests enhanced lyrics for v2 and maps cue words", async () => {
    const provider = await connectProvider({ extensions: [{ name: "songLyrics", versions: [1, 2] }] });
    mock.respond(() =>
      subsonicOk({
        lyricsList: {
          structuredLyrics: [
            {
              lang: "deu",
              synced: true,
              line: [
                { start: 0, value: "Hello world", cueLine: [{ start: 0, end: 400, value: "Hello " }] },
                { start: 1000, value: "Bye" },
              ],
              cueLine: [{ index: 1, start: 1000, end: 1200, value: "Bye" }],
            },
          ],
        },
      }),
    );
    const lyrics = await provider.getLyrics(track);
    expect(lastCall().params.get("enhanced")).toBe("true");
    expect(lyrics?.language).toBe("deu");
    expect(lyrics?.lines[0]!.words).toEqual([{ startMs: 0, endMs: 400, text: "Hello " }]);
    expect(lyrics?.lines[1]!.words).toEqual([{ startMs: 1000, endMs: 1200, text: "Bye" }]);
  });

  it("returns null when there are no lines or the song is unknown", async () => {
    const provider = await connectProvider({ extensions: [{ name: "songLyrics", versions: [1] }] });
    mock.respond(() => subsonicOk({ lyricsList: { structuredLyrics: [{ synced: true, line: [] }] } }));
    expect(await provider.getLyrics(track)).toBeNull();
    mock.respond(() => subsonicOk({ lyricsList: {} }));
    expect(await provider.getLyrics(track)).toBeNull();
    mock.respond(() => subsonicFailed(70, "not found"));
    expect(await provider.getLyrics(track)).toBeNull();
  });

  it("falls back to legacy plain lyrics", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk({ lyrics: { value: "line one\r\n \nline two\n" } }));
    const lyrics = await provider.getLyrics(track);
    expect(lastCall().endpoint).toBe("getLyrics");
    expect(lastCall().params.get("artist")).toBe("A");
    expect(lastCall().params.get("title")).toBe("Song");
    expect(lyrics).toEqual({
      synced: false,
      offsetMs: 0,
      source: "server",
      lines: [{ text: "line one" }, { text: "" }, { text: "line two" }],
    });
    mock.respond(() => subsonicOk({ lyrics: {} }));
    expect(await provider.getLyrics(track)).toBeNull();
  });
});

describe("media URLs", () => {
  const track = mapTrack("srv1", { ...child, suffix: "flac" });
  const credentialParams = ["t", "s", "p", "apiKey", "u"];

  it("builds raw stream and download URLs with a stable cache key", async () => {
    const provider = await connectProvider();
    const stream = provider.getStreamSource(track);
    const url = new URL(stream.url);
    expect(url.pathname).toBe("/rest/stream");
    expect(url.searchParams.get("id")).toBe("t1");
    expect(url.searchParams.get("format")).toBe("raw");
    expect(url.searchParams.get("u")).toBe("bob");
    expect(stream).toMatchObject({
      cacheKey: "srv1:t1:raw:0",
      transcoded: false,
      container: "flac",
      headers: {},
    });
    expect(stream.timeOffset).toBeUndefined();
    expect(provider.getStreamSource(track).url).toBe(stream.url);

    const download = provider.getDownloadSource(track);
    expect(new URL(download.url).pathname).toBe("/rest/download");
    expect(new URL(download.url).searchParams.has("format")).toBe(false);
    expect(download.cacheKey).toBe("srv1:t1:raw:0");
  });

  it("transcodes with format and bitrate, and offers timeOffset only when supported", async () => {
    let provider = await connectProvider();
    let s = provider.getStreamSource(track, { maxBitRateKbps: 192 });
    let q = new URL(s.url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      format: "mp3",
      maxBitRate: "192",
      estimateContentLength: "true",
    });
    expect(s).toMatchObject({ cacheKey: "srv1:t1:mp3:192", transcoded: true, container: "mp3" });
    expect(s.timeOffset).toBeUndefined();

    provider = await connectProvider({ extensions: [{ name: "transcodeOffset", versions: [1] }] });
    s = provider.getStreamSource(track, { maxBitRateKbps: 128, format: "opus" });
    q = new URL(s.url).searchParams;
    expect(q.get("format")).toBe("opus");
    expect(s.cacheKey).toBe("srv1:t1:opus:128");
    expect(s.timeOffset).toEqual({ param: "timeOffset", unit: "seconds" });

    const d = provider.getDownloadSource(track, { maxBitRateKbps: 128 });
    expect(new URL(d.url).pathname).toBe("/rest/stream");
  });

  it("never leaks credentials into cache keys, in any auth mode", async () => {
    for (const authMode of ["token", "password", "apiKey"] as const) {
      const provider = await connectProvider({
        server: { authMode, username: authMode === "apiKey" ? "" : "bob" },
      });
      for (const quality of [undefined, { maxBitRateKbps: 96 }]) {
        const key = provider.getStreamSource(track, quality).cacheKey;
        expect(key).not.toMatch(/(^|[?&:])(t|s|p|apiKey)=/);
        expect(key).not.toContain("pw");
      }
    }
  });

  it("uses mode-specific credentials in media URLs", async () => {
    const apiKey = await connectProvider({
      server: { authMode: "apiKey", username: "" },
      secret: "KEY",
    });
    const k = new URL(apiKey.getStreamSource(track).url).searchParams;
    expect(k.get("apiKey")).toBe("KEY");
    for (const name of ["u", "t", "s", "p"]) expect(k.has(name)).toBe(false);

    const legacy = await connectProvider({ server: { authMode: "password" } });
    const l = new URL(legacy.getStreamSource(track).url).searchParams;
    expect(l.get("p")).toBe("enc:7077");
    expect(l.has("t")).toBe(false);
    for (const name of credentialParams.filter((n) => n !== "p" && n !== "u"))
      expect(l.has(name)).toBe(false);
  });

  it("returns the same cover URL on every call", async () => {
    const provider = await connectProvider();
    const a = provider.coverUrl("al-1", 300);
    expect(provider.coverUrl("al-1", 300)).toBe(a);
    const q = new URL(a).searchParams;
    expect(new URL(a).pathname).toBe("/rest/getCoverArt");
    expect(q.get("id")).toBe("al-1");
    expect(q.get("size")).toBe("300");
    expect(new URL(provider.coverUrl("al-1")).searchParams.has("size")).toBe(false);
  });
});

describe("misc endpoints", () => {
  it("sends scrobble params", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk());
    await provider.reportPlayback({ type: "start", trackId: "t1", positionMs: 0 });
    expect(lastCall().params.get("submission")).toBe("false");
    await provider.reportPlayback({ type: "scrobble", trackId: "t1", playedAt: new Date(1_700_000_000_000) });
    expect(lastCall().params.get("time")).toBe("1700000000000");
    expect(lastCall().params.get("submission")).toBe("true");
    const before = mock.calls.length;
    await provider.reportPlayback({ type: "progress", trackId: "t1", positionMs: 5, paused: false });
    await provider.reportPlayback({ type: "stop", trackId: "t1", positionMs: 5 });
    expect(mock.calls).toHaveLength(before);
  });

  it("stars by kind and clears ratings with 0", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk());
    await provider.setStarred("album", "al1", true);
    expect(lastCall().endpoint).toBe("star");
    expect(lastCall().params.get("albumId")).toBe("al1");
    await provider.setStarred("artist", "ar1", false);
    expect(lastCall().endpoint).toBe("unstar");
    expect(lastCall().params.get("artistId")).toBe("ar1");
    await provider.setStarred("track", "t1", true);
    expect(lastCall().params.get("id")).toBe("t1");
    await provider.setRating?.("t1", null);
    expect(lastCall().params.get("rating")).toBe("0");
  });

  it("saves and loads the play queue", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk());
    await provider.savePlayQueue?.({ trackIds: ["a", "b"], currentId: "b", positionMs: 1234 });
    expect(lastCall().params.getAll("id")).toEqual(["a", "b"]);
    expect(lastCall().params.get("current")).toBe("b");
    expect(lastCall().params.get("position")).toBe("1234");

    mock.respond(() =>
      subsonicOk({
        playQueue: {
          entry: [{ id: "a" }, { id: "b" }],
          current: "b",
          position: 99,
          changed: "2025-01-01T00:00:00Z",
          changedBy: "web",
        },
      }),
    );
    expect(await provider.getPlayQueue?.()).toMatchObject({
      trackIds: ["a", "b"],
      tracks: [{ id: "a" }, { id: "b" }],
      currentId: "b",
      positionMs: 99,
      changedAt: "2025-01-01T00:00:00Z",
      changedBy: "web",
    });
    mock.respond(() => subsonicOk());
    expect(await provider.getPlayQueue?.()).toBeNull();
  });

  it("flattens artist indexes and returns null for empty artist info", async () => {
    const provider = await connectProvider();
    mock.respond(() =>
      subsonicOk({
        artists: {
          index: [
            { artist: [{ id: "1", name: "A", albumCount: 2 }] },
            { artist: [{ id: "2", name: "B", starred: "x" }] },
          ],
        },
      }),
    );
    const artists = await provider.getArtists();
    expect(artists.map((a) => a.id)).toEqual(["1", "2"]);
    expect(artists[1]!.starred).toBe(true);
    mock.respond(() => subsonicOk({ artistInfo2: {} }));
    expect(await provider.getArtistInfo("1")).toBeNull();
    mock.respond(() =>
      subsonicOk({ artistInfo2: { biography: "bio", similarArtist: [{ id: "2", name: "B" }] } }),
    );
    expect(await provider.getArtistInfo("1")).toMatchObject({
      biography: "bio",
      similarArtists: [{ id: "2" }],
    });
  });

  it("searches with limits and offsets", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicOk({ searchResult3: { song: [child] } }));
    const res = await provider.search("abc", { tracks: 5, offset: 10 });
    expect(res.tracks).toHaveLength(1);
    expect(res.albums).toEqual([]);
    expect(Object.fromEntries(lastCall().params)).toMatchObject({
      query: "abc",
      songCount: "5",
      songOffset: "10",
      artistCount: "20",
    });
  });
});

describe("error mapping", () => {
  it("maps API and HTTP errors", async () => {
    const provider = await connectProvider();
    mock.respond(() => subsonicFailed(70, "Album not found"));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "notFound", code: 70 });
    mock.respond(() => subsonicFailed(50, "not authorized"));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "auth" });
    mock.respond(() => subsonicFailed(0, "boom"));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "server" });
    mock.respond(() => new Response("x", { status: 403 }));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "auth", code: 403 });
    mock.respond(() => new Response("x", { status: 500 }));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "server", code: 500 });
    mock.respond(() => ({ nope: true }));
    await expect(provider.getAlbum("x")).rejects.toMatchObject({ kind: "invalidResponse" });
  });

  it("redacts credentials in error messages", async () => {
    const provider = await connectProvider();
    mock.respond(() => new Response("x", { status: 500 }));
    const error = await provider.getAlbum("x").catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/[?&]t=[0-9a-f]{32}/);
  });
});

import { ProviderError, type MusicProvider } from "@/api/provider";
import { fakeAlbums, fakePlaylists, fakeServer, fakeTracks } from "@/test/fakeProvider";
import { collectionRow, resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import { FAVORITES_ID } from "./actions";
import { createOfflineProvider } from "./offlineProvider";
import { useDownloads } from "./store";

vi.mock("./api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const track = (id: string) => fakeTracks.find((t) => t.id === id)!;
const ids = (tracks: { id: string }[]) => tracks.map((t) => t.id);
let offline: MusicProvider;

const { tracks: playlistTracks, ...playlistInfo } = fakePlaylists[0]!;

beforeEach(async () => {
  resetDownloads();
  offline = await createOfflineProvider(fakeServer);
});

/** Album al1 and the playlist are downloaded as collections; t7 (Nordlicht) on its own; t8 is still queued. */
function seedLibrary() {
  seedDownloads({
    tracks: [
      trackRow(track("t1")),
      trackRow(track("t2")),
      trackRow(track("t3")),
      trackRow(track("t5")),
      trackRow(track("t7"), "done", { individual: true }),
      trackRow(track("t8"), "queued"),
      trackRow(track("t9")),
    ],
    collections: [
      collectionRow("album", "al1", "Morning Static", { kind: "album", album: fakeAlbums[0]! }, [
        "t1",
        "t2",
        "t3",
      ]),
      collectionRow(
        "playlist",
        "pl1",
        "Road Trip",
        { kind: "playlist", playlist: playlistInfo },
        playlistTracks.map((t) => t.id),
      ),
      collectionRow("favorites", FAVORITES_ID, "Favorites", { kind: "favorites", username: "tester" }, [
        "t3",
        "t9",
      ]),
    ],
  });
}

describe("offline provider", () => {
  it("serves an album from its stored snapshot with the downloaded tracks only", async () => {
    seedLibrary();
    const album = await offline.getAlbum("al1");
    expect(album.name).toBe("Morning Static");
    expect(ids(album.tracks)).toEqual(["t1", "t2", "t3"]);
    expect(album.trackCount).toBe(3);
  });

  it("assembles an album from single downloaded tracks", async () => {
    seedLibrary();
    const album = await offline.getAlbum("al3");
    expect(album).toMatchObject({ id: "al3", name: "Nordlicht", artistLine: "Kollektiv Nord" });
    expect(ids(album.tracks)).toEqual(["t7", "t9"]);
  });

  it("answers 'not found' for albums that are not downloaded", async () => {
    seedLibrary();
    await expect(offline.getAlbum("al-missing")).rejects.toMatchObject({ kind: "notFound" });
  });

  it("serves playlists and favorites from the stored collections", async () => {
    seedLibrary();
    const playlists = await offline.getPlaylists();
    expect(playlists).toHaveLength(1);
    // Only t1, t5, t7 and t9 of the playlist are on disk.
    expect(playlists[0]).toMatchObject({ id: "pl1", name: "Road Trip", trackCount: 4, readOnly: true });
    const detail = await offline.getPlaylist("pl1");
    expect(ids(detail.tracks)).toEqual(["t1", "t5", "t7", "t9"]);

    const starred = await offline.getStarred();
    expect(ids(starred.tracks)).toEqual(["t3", "t9"]);
    expect(starred.albums.map((a) => a.id)).toEqual(["al1"]);
  });

  it("lists downloaded albums for the home page", async () => {
    seedLibrary();
    const albums = await offline.getAlbumList("recentlyAdded", { size: 10 });
    expect(albums.map((a) => a.id).sort()).toEqual(["al1", "al2", "al3"]);
    expect(await offline.getAlbumList("recentlyAdded", { size: 1 })).toHaveLength(1);
  });

  it("searches inside the downloaded music", async () => {
    seedLibrary();
    const result = await offline.search("nord");
    expect(result.albums.map((a) => a.name)).toEqual(["Nordlicht"]);
    expect(ids(result.tracks)).toEqual(["t7", "t9"]);
    expect((await offline.search("zzz")).tracks).toEqual([]);
  });

  it("knows artists, genres and top tracks of the downloads", async () => {
    seedLibrary();
    expect((await offline.getArtists()).map((a) => a.name)).toEqual(["Aurora Lane", "Kollektiv Nord"]);
    const artist = await offline.getArtist("ar1");
    expect(artist.albums.map((a) => a.id).sort()).toEqual(["al1", "al2"]);
    expect(await offline.getGenres()).toEqual([{ name: "Electronic", trackCount: 6, albumCount: 3 }]);
    const top = await offline.getTopTracks({ id: "ar1", name: "Aurora Lane" }, 2);
    expect(ids(top)).toEqual(["t5", "t3"]);
  });

  it("stays in step with the store while downloads finish", async () => {
    seedLibrary();
    expect(ids(await offline.getTracksByGenre("Electronic"))).not.toContain("t8");
    useDownloads.getState().applyUpdates([
      {
        serverId: "srv1",
        trackId: "t8",
        state: "done",
        bytesDone: 5,
        bytesTotal: 5,
        error: null,
        path: "D:/x/t8.flac",
        sizeBytes: 5,
      },
    ]);
    expect(ids(await offline.getTracksByGenre("Electronic"))).toContain("t8");
  });

  it("rejects everything that needs the server with a network error", async () => {
    seedLibrary();
    const calls: (() => unknown)[] = [
      () => offline.ping(),
      () => offline.setStarred("track", "t1", true),
      () => offline.createPlaylist("x"),
      () => offline.addToPlaylist("pl1", ["t1"]),
      () => offline.deletePlaylist("pl1"),
      () => offline.getStreamSource(track("t1")),
      () => offline.getDownloadSource(track("t1")),
    ];
    for (const call of calls) {
      let error: unknown;
      try {
        await call();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe("network");
    }
  });

  it("points covers at the images saved with downloaded albums", () => {
    expect(offline.coverUrl("al1")).toBe("navdl://localhost/srv1%2Fal1");
  });

  it("is empty, not broken, when nothing is downloaded", async () => {
    expect(await offline.getPlaylists()).toEqual([]);
    expect(await offline.getAlbumList("recentlyAdded")).toEqual([]);
    expect((await offline.getStarred()).tracks).toEqual([]);
    expect((await offline.search("a")).tracks).toEqual([]);
  });
});

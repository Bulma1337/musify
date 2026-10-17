import type { MusicProvider } from "@/api/provider";
import { useSettings } from "@/settings/store";
import { createFakeProvider, fakeAlbums, fakePlaylists, fakeTracks } from "@/test/fakeProvider";
import { collectionRow, resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import {
  buildJob,
  downloadCollection,
  downloadTracks,
  FAVORITES_ID,
  removeCollectionDownload,
  removeTrackDownloads,
  resumePending,
  retryDownload,
  syncCollection,
} from "./actions";
import { downloadsApi } from "./api";
import { albumSpec, favoritesSpec } from "./specs";
import { useDownloads } from "./store";
import type { EnqueueJob } from "./types";

vi.mock("./api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const track = (id: string) => fakeTracks.find((t) => t.id === id)!;
let provider: MusicProvider;

function enqueuedJobs(): EnqueueJob[] {
  return vi.mocked(downloadsApi.enqueue).mock.calls.flatMap(([jobs]) => jobs);
}

beforeEach(() => {
  vi.clearAllMocks();
  provider = createFakeProvider();
  resetDownloads();
  useSettings.setState({ downloadQuality: "original" });
});

describe("buildJob", () => {
  it("describes the track, its source and where the file belongs", () => {
    const job = buildJob(provider, track("t1"), { individual: true, quality: "original" });
    expect(job).toMatchObject({
      serverId: "srv1",
      trackId: "t1",
      quality: "original",
      individual: true,
      source: { url: "http://test.local/download/t1", headers: [], allowInsecureTls: false },
      layout: {
        serverName: "Test Server",
        albumArtist: "Aurora Lane",
        album: "Morning Static",
        title: "Song 1",
        discNumber: 1,
        trackNumber: 1,
      },
      container: "flac",
      cover: { coverRef: "al1", source: { url: "http://test.local/cover/al1?size=1000" } },
    });
  });

  it("keeps the credentials out of the stored snapshot", () => {
    const job = buildJob(provider, track("t1"), { individual: false, quality: "original" });
    expect(job.trackJson).not.toContain("http://test.local/download");
    expect(JSON.parse(job.trackJson)).toMatchObject({ id: "t1", title: "Song 1" });
  });

  it("passes the server's TLS exception along", () => {
    const insecure = { ...provider, server: { ...provider.server, allowInsecureTls: true } } as MusicProvider;
    const job = buildJob(insecure, track("t1"), { individual: false, quality: "original" });
    expect(job.source.allowInsecureTls).toBe(true);
    expect(job.cover?.source.allowInsecureTls).toBe(true);
  });
});

describe("downloadTracks", () => {
  it("queues tracks as individual downloads in the chosen quality", async () => {
    useSettings.setState({ downloadQuality: "high" });
    await downloadTracks(provider, [track("t1"), track("t2")]);

    expect(enqueuedJobs().map((j) => [j.trackId, j.individual, j.quality])).toEqual([
      ["t1", true, "high"],
      ["t2", true, "high"],
    ]);
    const { entries } = useDownloads.getState();
    expect(entries.t1).toMatchObject({ state: "queued", individual: true, quality: "high" });
  });

  it("does nothing where downloads are not available", async () => {
    resetDownloads(false);
    await downloadTracks(provider, [track("t1")]);
    expect(downloadsApi.enqueue).not.toHaveBeenCalled();
    expect(useDownloads.getState().entries).toEqual({});
  });

  it("takes the optimistic entries back when the native side refuses", async () => {
    vi.mocked(downloadsApi.enqueue).mockRejectedValueOnce("the downloads folder is being moved");
    await expect(downloadTracks(provider, [track("t1")])).rejects.toBe("the downloads folder is being moved");
    expect(useDownloads.getState().entries.t1).toBeUndefined();
  });
});

describe("removeTrackDownloads", () => {
  it("reports which tracks went away and which stay because a collection holds them", async () => {
    seedDownloads({ tracks: [trackRow(track("t1"), "done", { individual: true }), trackRow(track("t2"))] });
    vi.mocked(downloadsApi.removeTrack).mockImplementation(async (_server, id) => id === "t1");

    const result = await removeTrackDownloads("srv1", ["t1", "t2"]);

    expect(result).toEqual({ removed: ["t1"], kept: ["t2"] });
    const { entries } = useDownloads.getState();
    expect(entries.t1).toBeUndefined();
    expect(entries.t2?.individual).toBe(false);
  });
});

describe("downloadCollection", () => {
  it("registers the album and queues only the tracks that are not there yet", async () => {
    const detail = await provider.getAlbum("al2"); // t4, t5 on disc 1, t6 on disc 2
    seedDownloads({ tracks: [trackRow(track("t4"))] });

    await downloadCollection(provider, albumSpec(detail));

    expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1);
    const [collection, jobs] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection).toMatchObject({
      serverId: "srv1",
      kind: "album",
      itemId: "al2",
      name: "Night Drive",
      trackIds: ["t4", "t5", "t6"],
    });
    expect(JSON.parse(collection.json)).toMatchObject({ kind: "album", album: { id: "al2" } });
    expect(jobs.map((j) => j.trackId)).toEqual(["t5", "t6"]);
    // Collection downloads are not "individual"; the disc count lets file names carry the disc.
    expect(jobs.every((j) => !j.individual && j.layout.discTotal === 2)).toBe(true);

    const { collections, entries } = useDownloads.getState();
    expect(collections["album:al2"]?.trackIds).toEqual(["t4", "t5", "t6"]);
    expect(entries.t5?.state).toBe("queued");
    expect(entries.t4?.state).toBe("done");
  });

  it("registers the favorites under a fixed id", async () => {
    const tracks = [track("t4"), track("t8")];
    await downloadCollection(provider, favoritesSpec(tracks, "Favorites", "tester"));
    const [collection] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection).toMatchObject({ kind: "favorites", itemId: FAVORITES_ID, trackIds: ["t4", "t8"] });
  });

  it("removes the registration and reloads the truth", async () => {
    seedDownloads({
      collections: [
        collectionRow("album", "al1", "Morning Static", { kind: "album", album: fakeAlbums[0]! }, []),
      ],
    });
    await removeCollectionDownload("srv1", "album", "al1");
    expect(downloadsApi.removeCollection).toHaveBeenCalledWith("srv1", "album", "al1");
    expect(useDownloads.getState().collections["album:al1"]).toBeUndefined();
  });
});

describe("syncCollection", () => {
  const playlist = fakePlaylists[0]!;
  const { tracks: playlistTracks, ...playlistInfo } = playlist;

  function seedPlaylist(trackIds: string[], doneIds: string[]) {
    seedDownloads({
      tracks: trackIds.map((id) => trackRow(track(id), doneIds.includes(id) ? "done" : "queued")),
      collections: [
        collectionRow("playlist", "pl1", "Road Trip", { kind: "playlist", playlist: playlistInfo }, trackIds),
      ],
    });
  }

  it("does nothing when the server content is unchanged and everything is downloaded", async () => {
    const ids = playlistTracks.map((t) => t.id);
    seedPlaylist(ids, ids);
    await syncCollection(provider, "playlist", "pl1");
    expect(downloadsApi.setCollection).not.toHaveBeenCalled();
  });

  it("fetches new tracks and drops removed ones when the playlist changed", async () => {
    const ids = playlistTracks.map((t) => t.id);
    seedPlaylist(ids.slice(0, 2), ids.slice(0, 2));
    await syncCollection(provider, "playlist", "pl1");

    expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1);
    const [collection, jobs] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection.trackIds).toEqual(ids);
    expect(jobs.map((j) => j.trackId)).toEqual(ids.slice(2));
  });

  it("queues tracks again that never finished", async () => {
    const ids = playlistTracks.map((t) => t.id);
    seedPlaylist(ids, ids.slice(0, 3));
    await syncCollection(provider, "playlist", "pl1");
    const [, jobs] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(jobs.map((j) => j.trackId)).toEqual(ids.slice(3));
  });

  it("ignores collections that are not downloaded", async () => {
    await syncCollection(provider, "playlist", "pl1");
    expect(downloadsApi.setCollection).not.toHaveBeenCalled();
  });

  it("keeps the favorites newest first", async () => {
    const starredTracks = [
      { ...track("t4"), starred: true, starredAt: "2026-01-01T00:00:00Z" },
      { ...track("t8"), starred: true, starredAt: "2026-03-01T00:00:00Z" },
    ];
    vi.spyOn(provider, "getStarred").mockResolvedValue({ tracks: starredTracks, albums: [], artists: [] });
    seedDownloads({
      collections: [
        collectionRow("favorites", FAVORITES_ID, "Favorites", { kind: "favorites", username: "tester" }, []),
      ],
    });
    await syncCollection(provider, "favorites", FAVORITES_ID);
    const [collection] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection.trackIds).toEqual(["t8", "t4"]);
    expect(collection.name).toBe("Favorites");
  });
});

describe("retry and resume", () => {
  it("queues a failed track again with its original settings", async () => {
    seedDownloads({ tracks: [trackRow(track("t1"), "failed", { individual: true, quality: "low" })] });
    await retryDownload(provider, "t1");
    expect(enqueuedJobs()).toEqual([
      expect.objectContaining({ trackId: "t1", individual: true, quality: "low" }),
    ]);
    expect(useDownloads.getState().entries.t1?.state).toBe("queued");
  });

  it("hands unfinished downloads to the downloader again after a restart", async () => {
    seedDownloads({
      tracks: [trackRow(track("t1")), trackRow(track("t2"), "queued"), trackRow(track("t3"), "failed")],
    });
    await resumePending(provider);
    expect(enqueuedJobs().map((j) => j.trackId)).toEqual(["t2"]);
  });
});

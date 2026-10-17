import type { Track } from "@/api/provider";
import { fakeAlbums, fakeTracks } from "@/test/fakeProvider";
import { collectionRow, resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import { downloadsApi } from "./api";
import { collectionStatus, doneEntries, summarize, useDownloads } from "./store";
import type { DownloadUpdate } from "./types";

vi.mock("./api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const [t1, t2, t3, t4] = ["t1", "t2", "t3", "t4"].map((id) => fakeTracks.find((t) => t.id === id)!) as [
  Track,
  Track,
  Track,
  Track,
];

function update(trackId: string, patch: Partial<DownloadUpdate>): DownloadUpdate {
  return {
    serverId: "srv1",
    trackId,
    state: "downloading",
    bytesDone: 0,
    bytesTotal: null,
    error: null,
    path: null,
    sizeBytes: 0,
    ...patch,
  };
}

beforeEach(() => resetDownloads());

describe("downloads store", () => {
  it("loads rows and snapshots from the database listing", async () => {
    vi.mocked(downloadsApi.list).mockResolvedValueOnce({
      dir: "E:/dl",
      tracks: [trackRow(t1), trackRow(t2, "queued")],
      collections: [
        collectionRow(
          "album",
          "al1",
          "Morning Static",
          { kind: "album", album: { ...fakeAlbums[0]!, starred: false } },
          [t1.id, t2.id],
        ),
      ],
    });
    useDownloads.getState().reset();
    await useDownloads.getState().load("srv1");

    const state = useDownloads.getState();
    expect(state.loaded).toBe(true);
    expect(state.dir).toBe("E:/dl");
    expect(state.entries[t1.id]).toMatchObject({ state: "done", path: expect.stringContaining("t1.flac") });
    expect(state.entries[t2.id]?.state).toBe("queued");
    expect(state.entries[t2.id]?.path).toBeNull();
    expect(state.collections["album:al1"]?.trackIds).toEqual([t1.id, t2.id]);
    expect(downloadsApi.subscribe).toHaveBeenCalled();
  });

  it("skips rows with damaged snapshots instead of failing", async () => {
    vi.mocked(downloadsApi.list).mockResolvedValueOnce({
      dir: "",
      tracks: [{ ...trackRow(t1), trackJson: "{broken" }, trackRow(t2)],
      collections: [],
    });
    useDownloads.getState().reset();
    await useDownloads.getState().load("srv1");
    expect(Object.keys(useDownloads.getState().entries)).toEqual([t2.id]);
  });

  it("only loads once per server unless forced", async () => {
    vi.mocked(downloadsApi.list).mockClear();
    useDownloads.getState().reset();
    await useDownloads.getState().load("srv1");
    await useDownloads.getState().load("srv1");
    expect(downloadsApi.list).toHaveBeenCalledTimes(1);
    await useDownloads.getState().load("srv1", { force: true });
    expect(downloadsApi.list).toHaveBeenCalledTimes(2);
  });

  it("moves a track through queued → downloading → done from progress updates", () => {
    const store = useDownloads.getState();
    store.markQueued([t1], { quality: "original", individual: true });
    expect(useDownloads.getState().entries[t1.id]).toMatchObject({ state: "queued", individual: true });

    store.applyUpdates([update(t1.id, { bytesDone: 40, bytesTotal: 100 })]);
    expect(useDownloads.getState().entries[t1.id]).toMatchObject({
      state: "downloading",
      bytesDone: 40,
      bytesTotal: 100,
    });

    store.applyUpdates([
      update(t1.id, { state: "done", path: "D:/x/t1.flac", sizeBytes: 100, bytesDone: 100, bytesTotal: 100 }),
    ]);
    const done = useDownloads.getState().entries[t1.id]!;
    expect(done).toMatchObject({ state: "done", path: "D:/x/t1.flac", sizeBytes: 100 });
    expect(useDownloads.getState().localPath("srv1", t1.id)).toBe("D:/x/t1.flac");
  });

  it("records failures and removals", () => {
    const store = useDownloads.getState();
    store.markQueued([t1, t2], { quality: "original", individual: false });
    store.applyUpdates([
      update(t1.id, { state: "failed", error: "HTTP status 404" }),
      update(t2.id, { state: "removed" }),
    ]);
    const { entries } = useDownloads.getState();
    expect(entries[t1.id]).toMatchObject({ state: "failed", error: "HTTP status 404" });
    expect(entries[t2.id]).toBeUndefined();
    expect(useDownloads.getState().localPath("srv1", t1.id)).toBeNull();
  });

  it("ignores updates of other servers and of tracks it does not know", () => {
    const before = useDownloads.getState().entries;
    useDownloads
      .getState()
      .applyUpdates([
        update(t1.id, { serverId: "other", state: "done", path: "x" }),
        update("unknown", { state: "done", path: "y" }),
      ]);
    expect(useDownloads.getState().entries).toBe(before);
  });

  it("keeps a finished track finished when it is queued again", () => {
    seedDownloads({ tracks: [trackRow(t1)] });
    useDownloads.getState().markQueued([t1], { quality: "low", individual: true });
    expect(useDownloads.getState().entries[t1.id]).toMatchObject({ state: "done", individual: true });
  });

  it("only exposes the path of finished files of the current server", () => {
    seedDownloads({ tracks: [trackRow(t1), trackRow(t2, "downloading")] });
    const { localPath } = useDownloads.getState();
    expect(localPath("srv1", t1.id)).toContain("t1.flac");
    expect(localPath("srv1", t2.id)).toBeNull();
    expect(localPath("srv1", "missing")).toBeNull();
    expect(localPath("other", t1.id)).toBeNull();
  });

  it("derives the status of a collection, counting partial progress", () => {
    seedDownloads({
      tracks: [trackRow(t1), trackRow(t2, "downloading"), trackRow(t3, "failed"), trackRow(t4, "queued")],
      collections: [
        collectionRow("playlist", "pl1", "Road Trip", { kind: "playlist", playlist: {} as never }, [
          t1.id,
          t2.id,
          t3.id,
          t4.id,
        ]),
      ],
    });
    useDownloads.getState().applyUpdates([update(t2.id, { bytesDone: 50, bytesTotal: 100 })]);
    const status = collectionStatus(useDownloads.getState(), "playlist", "pl1");
    expect(status).toMatchObject({ registered: true, total: 4, done: 1, failed: 1, active: 2 });
    expect(status.progress).toBeCloseTo((1 + 0.5) / 4);
    expect(collectionStatus(useDownloads.getState(), "album", "nope").registered).toBe(false);
  });

  it("summarizes the queue for the title bar", () => {
    seedDownloads({ tracks: [trackRow(t1), trackRow(t2, "downloading"), trackRow(t3, "failed")] });
    useDownloads.getState().applyUpdates([update(t2.id, { bytesDone: 25, bytesTotal: 100 })]);
    expect(summarize(useDownloads.getState().entries)).toEqual({
      done: 1,
      failed: 1,
      active: 1,
      progress: 0.25,
    });
    expect(doneEntries(useDownloads.getState().entries).map((e) => e.track.id)).toEqual([t1.id]);
  });
});

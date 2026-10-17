import { track } from "@/test/historyFixtures";
import type { HistoryStore } from "./history";
import { MemoryHistory } from "./memoryHistory";
import { buildPlayRecord, recordPlay } from "./recorder";

const t1 = track("t1");

describe("buildPlayRecord", () => {
  it("snapshots metadata without any URL", () => {
    const row = buildPlayRecord(t1, {
      startedAt: 1_000,
      playedMs: 150_000,
      completed: true,
      counted: true,
      context: { type: "album", id: "al1" },
      tzOffsetMin: 120,
    });
    expect(row).toMatchObject({
      serverId: "srv1",
      trackId: "t1",
      startedAt: 1_000,
      playedMs: 150_000,
      durationMs: t1.durationMs,
      title: "Song 1",
      artist: "Aurora Lane",
      artistId: "ar1",
      album: "Morning Static",
      albumId: "al1",
      genre: "Electronic",
      cover: "al1",
      contextType: "album",
      contextId: "al1",
      tzOffsetMin: 120,
    });
    expect(JSON.stringify(row)).not.toMatch(/https?:/);
  });

  it("marks an early stop as skipped and a counted listen as not skipped", () => {
    const base = { startedAt: 0, tzOffsetMin: 0 };
    expect(buildPlayRecord(t1, { ...base, playedMs: 5_000, completed: false, counted: false }).skipped).toBe(
      true,
    );
    expect(buildPlayRecord(t1, { ...base, playedMs: 120_000, completed: false, counted: true }).skipped).toBe(
      false,
    );
    // Completed but too short to count (a 20 s track): neither a play nor a skip.
    const short = buildPlayRecord(t1, { ...base, playedMs: 20_000, completed: true, counted: false });
    expect(short).toMatchObject({ counted: false, skipped: false, completed: true });
  });

  it("uses the device's UTC offset by default", () => {
    const now = Date.now();
    expect(
      buildPlayRecord(t1, { startedAt: now, playedMs: 1000, completed: false, counted: false }).tzOffsetMin,
    ).toBe(-new Date(now).getTimezoneOffset());
  });
});

describe("recordPlay", () => {
  it("stores a row", async () => {
    const store = new MemoryHistory();
    recordPlay(t1, { startedAt: 1, playedMs: 200_000, completed: true, counted: true }, store);
    expect(store.count()).toBe(1);
  });

  it("ignores listens shorter than a second", () => {
    const store = new MemoryHistory();
    recordPlay(t1, { startedAt: 1, playedMs: 400, completed: false, counted: false }, store);
    expect(store.count()).toBe(0);
  });

  it("never throws, whether the store rejects or throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejecting = { record: () => Promise.reject(new Error("disk full")) } as unknown as HistoryStore;
    const throwing = {
      record: () => {
        throw new Error("boom");
      },
    } as unknown as HistoryStore;
    const info = { startedAt: 1, playedMs: 5_000, completed: false, counted: false };
    expect(() => recordPlay(t1, info, rejecting)).not.toThrow();
    expect(() => recordPlay(t1, info, throwing)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

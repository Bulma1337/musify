import { at, playOnDays, playRow, track } from "@/test/historyFixtures";
import { DAY_MS, MemoryHistory, longestStreak } from "./memoryHistory";
import type { PlayRecord } from "./history";

const SERVER = "srv1";
const all = (history: MemoryHistory) => history.summary(SERVER, 0, Number.MAX_SAFE_INTEGER, 10);
const utc = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min);

function store(rows: PlayRecord[]) {
  const history = new MemoryHistory();
  history.addAll(rows);
  return history;
}

describe("MemoryHistory summary", () => {
  it("gives zeroes for an empty history", async () => {
    const s = await all(new MemoryHistory());
    expect(s.playedMs).toBe(0);
    expect(s.plays).toBe(0);
    expect(s.topTracks).toEqual([]);
    expect(s.longestStreak.days).toBe(0);
    expect(s.months).toEqual([]);
  });

  it("counts minutes for skips too but plays only for counted rows", async () => {
    const s = await all(
      store([
        playRow(track("t1"), at(2026, 3, 1), { playedMs: 200_000 }),
        playRow(track("t2"), at(2026, 3, 1, 13), { counted: false, playedMs: 10_000 }),
      ]),
    );
    expect(s.playedMs).toBe(210_000);
    expect(s.plays).toBe(1);
    expect(s.skips).toBe(1);
    expect(s.distinctTracks).toBe(1);
    // A track that was only skipped is not in the top list.
    expect(s.topTracks.map((r) => r.id)).toEqual(["t1"]);
  });

  it("ranks by plays, then minutes, and respects the range and the limit", async () => {
    const rows = [
      ...playOnDays("t1", 2025, 5, [1, 2, 3]),
      ...playOnDays("t7", 2026, 1, [1, 2]),
      ...playOnDays("t8", 2026, 1, [5]),
      playRow(track("t4"), at(2026, 1, 6), { playedMs: 900_000 }),
    ];
    const history = store(rows);
    const s = await all(history);
    expect(s.topTracks.map((r) => r.id)).toEqual(["t1", "t7", "t4", "t8"]);
    expect(s.topArtists[0]).toMatchObject({ title: "Aurora Lane", plays: 4 });
    expect(s.topAlbums.length).toBeGreaterThan(1);
    expect(s.topGenres[0]).toMatchObject({ title: "Electronic", plays: 7 });

    const year2026 = await history.summary(SERVER, at(2026, 1, 1, 0), at(2027, 1, 1, 0), 10);
    expect(year2026.plays).toBe(4);
    expect(year2026.topTracks[0]?.id).toBe("t7");
    expect((await history.summary(SERVER, 0, Number.MAX_SAFE_INTEGER, 2)).topTracks).toHaveLength(2);
  });

  it("ignores other servers", async () => {
    const history = store([playRow(track("t1"), at(2026, 3, 1))]);
    expect((await history.summary("other", 0, Number.MAX_SAFE_INTEGER, 10)).plays).toBe(0);
  });

  it("builds the heatmap from the recorded local time, Monday first", async () => {
    const s = await all(
      store([
        // Sunday 2026-03-01 23:30 UTC at UTC+2 is Monday 01:30 local.
        playRow(track("t1"), utc(2026, 3, 1, 23, 30), { tzOffsetMin: 120, playedMs: 60_000 }),
        // Wednesday 2026-03-04 08:10 UTC at UTC-5 is Wednesday 03:10 local.
        playRow(track("t1"), utc(2026, 3, 4, 8, 10), { tzOffsetMin: -300, playedMs: 30_000 }),
        // Sunday noon goes to the last row.
        playRow(track("t1"), utc(2026, 3, 1, 12), { tzOffsetMin: 0, playedMs: 5_000 }),
      ]),
    );
    expect(s.heatmap[0]![1]).toBe(60_000);
    expect(s.heatmap[2]![3]).toBe(30_000);
    expect(s.heatmap[6]![12]).toBe(5_000);
    expect(s.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(95_000);
  });

  it("finds the longest streak and counts a day once", async () => {
    const rows = [1, 2, 3, 6, 7, 8, 9, 12, 13].flatMap((d) => [
      playRow(track("t1"), at(2026, 3, d, 12)),
      playRow(track("t2"), at(2026, 3, d, 13)),
    ]);
    const s = await all(store(rows));
    expect(s.longestStreak.days).toBe(4);
    expect(s.activeDays).toBe(9);
    expect(s.longestStreak.endDay - s.longestStreak.startDay).toBe(3);
  });

  it("follows local midnight for streaks and does not extend them with skips", async () => {
    const wrap = await all(
      store([
        // Mar 2 and Mar 3 locally, although UTC has a gap day in between.
        playRow(track("t1"), utc(2026, 3, 1, 23, 30), { tzOffsetMin: 60 }),
        playRow(track("t1"), utc(2026, 3, 3, 0, 30), { tzOffsetMin: 60 }),
      ]),
    );
    expect(wrap.longestStreak.days).toBe(2);
    const skipped = await all(
      store([
        playRow(track("t1"), utc(2026, 3, 1)),
        playRow(track("t1"), utc(2026, 3, 2), { counted: false }),
      ]),
    );
    expect(skipped.longestStreak.days).toBe(1);
  });

  it("reports tracks and artists first played inside the range as discoveries", async () => {
    const history = store([
      playRow(track("t1"), at(2025, 6, 1)),
      playRow(track("t1"), at(2026, 6, 1)),
      playRow(track("t7"), at(2026, 2, 1)),
      playRow(track("t7"), at(2026, 2, 2)),
    ]);
    const s = await history.summary(SERVER, at(2026, 1, 1, 0), at(2027, 1, 1, 0), 10);
    expect(s.plays).toBe(3);
    expect(s.discoveries.tracks).toBe(1);
    expect(s.discoveries.artists).toBe(1);
    expect(s.discoveries.top.map((r) => r.id)).toEqual(["t7"]);
  });

  it("groups months in local time", async () => {
    const s = await all(
      store([
        playRow(track("t1"), utc(2026, 1, 15), { playedMs: 100_000 }),
        playRow(track("t1"), utc(2026, 3, 15), { playedMs: 100_000 }),
        playRow(track("t1"), utc(2026, 3, 16), { playedMs: 100_000 }),
        // 23:30 UTC on Jan 31 at UTC+2 is February 1st locally.
        playRow(track("t1"), utc(2026, 1, 31, 23, 30), { tzOffsetMin: 120, playedMs: 100_000 }),
      ]),
    );
    expect(s.months.map((m) => [m.month, m.plays])).toEqual([
      ["2026-01", 1],
      ["2026-02", 1],
      ["2026-03", 2],
    ]);
    expect(s.months[2]!.playedMs).toBe(200_000);
  });
});

describe("MemoryHistory track lists", () => {
  const now = at(2026, 6, 30);
  const ago = (days: number) => now - days * DAY_MS;

  it("heavy rotation: last 30 days, at least two plays", async () => {
    const history = store([
      ...[0, 1, 2].map((i) => playRow(track("t1"), ago(i))),
      ...[5, 6].map((i) => playRow(track("t2"), ago(i))),
      playRow(track("t3"), ago(1)),
      ...[40, 41, 42, 43, 44].map((i) => playRow(track("t4"), ago(i))),
    ]);
    const rows = await history.tracks(SERVER, { kind: "heavyRotation", nowMs: now, limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("rediscovered: many old plays and a quiet period", async () => {
    const history = store([
      ...[240, 241, 242, 243, 244].map((i) => playRow(track("t1"), ago(i))),
      ...[200, 201, 202, 203].map((i) => playRow(track("t2"), ago(i))),
      playRow(track("t2"), ago(20)),
      ...[220, 221].map((i) => playRow(track("t3"), ago(i))),
      ...[210, 211, 212].map((i) => playRow(track("t4"), ago(i))),
      playRow(track("t4"), ago(90)),
    ]);
    const rows = await history.tracks(SERVER, { kind: "rediscovered", nowMs: now, limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["t1", "t4"]);
    expect(rows[0]!.plays).toBe(5);
  });

  it("range: the top tracks of the range", async () => {
    const history = store([
      playRow(track("t1"), at(2025, 12, 31)),
      playRow(track("t2"), at(2026, 1, 1)),
      playRow(track("t2"), at(2026, 1, 2)),
    ]);
    const rows = await history.tracks(SERVER, {
      kind: "range",
      nowMs: 0,
      fromMs: at(2026, 1, 1, 0),
      toMs: at(2027, 1, 1, 0),
      limit: 50,
    });
    expect(rows.map((r) => [r.id, r.plays])).toEqual([["t2", 2]]);
  });

  it("uses the latest metadata of a track", async () => {
    const renamed = { ...playRow(track("t1"), at(2026, 1, 2)), title: "Renamed" };
    const history = store([playRow(track("t1"), at(2026, 1, 1)), renamed]);
    const rows = await history.tracks(SERVER, { kind: "range", nowMs: 0, limit: 5 });
    expect(rows[0]).toMatchObject({ title: "Renamed", plays: 2 });
  });

  it("lists local calendar years with plays", async () => {
    const history = store([
      playRow(track("t1"), utc(2024, 7, 1)),
      playRow(track("t1"), utc(2026, 7, 1)),
      playRow(track("t1"), utc(2026, 12, 31, 23, 30), { tzOffsetMin: 60 }),
    ]);
    expect(await history.years(SERVER)).toEqual([2024, 2026, 2027]);
  });
});

describe("longestStreak", () => {
  it("keeps the earliest of equally long streaks", () => {
    expect(longestStreak([1, 2, 5, 6])).toEqual({ days: 2, startDay: 1, endDay: 2 });
    expect(longestStreak([])).toEqual({ days: 0, startDay: 0, endDay: 0 });
  });
});

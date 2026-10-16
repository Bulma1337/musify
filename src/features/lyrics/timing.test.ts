import type { LyricLine } from "@/api/provider";
import {
  activeLineIndex,
  displayStartMs,
  getLyricsOffset,
  PlaybackClock,
  setLyricsOffset,
} from "./timing";

const lines: LyricLine[] = [1000, 2000, 2000, 5000].map((startMs, i) => ({ startMs, text: `l${i}` }));

describe("activeLineIndex", () => {
  it("is -1 before the first line and for empty input", () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 999)).toBe(-1);
    expect(activeLineIndex([], 5000)).toBe(-1);
  });

  it("finds the last line that started", () => {
    expect(activeLineIndex(lines, 1000)).toBe(0);
    expect(activeLineIndex(lines, 1999)).toBe(0);
    expect(activeLineIndex(lines, 2000)).toBe(2);
    expect(activeLineIndex(lines, 4999)).toBe(2);
    expect(activeLineIndex(lines, 5000)).toBe(3);
    expect(activeLineIndex(lines, 999_999)).toBe(3);
  });

  it("agrees with a linear scan on many lines", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ startMs: i * 700, text: "" }));
    for (const t of [0, 1, 699, 700, 12_345, 349_300, 400_000]) {
      const expected = many.reduce((found, l, i) => (l.startMs <= t ? i : found), -1);
      expect(activeLineIndex(many, t)).toBe(expected);
    }
  });
});

describe("displayStartMs", () => {
  it("adds the lyrics offset and the user offset and never goes negative", () => {
    const lyrics = { synced: true, lines: [], offsetMs: -500, source: "server" as const };
    expect(displayStartMs(lyrics, 10_000, 200)).toBe(9_700);
    expect(displayStartMs(lyrics, 100, 0)).toBe(0);
  });
});

describe("PlaybackClock", () => {
  it("interpolates while running and freezes when paused", () => {
    const clock = new PlaybackClock();
    clock.update(10_000, true, 1_000, true);
    expect(clock.now(1_000)).toBe(10_000);
    expect(clock.now(1_450)).toBe(10_450);
    clock.update(10_450, false, 1_450, false);
    expect(clock.now(9_000)).toBe(10_450);
  });

  it("snaps to the reported position on a seek", () => {
    const clock = new PlaybackClock();
    clock.update(10_000, true, 0, true);
    clock.update(60_000, true, 500, true);
    expect(clock.now(500)).toBe(60_000);
    clock.update(2_000, true, 600, true);
    expect(clock.now(600)).toBe(2_000);
  });

  it("does not jump backwards for a slightly late report but follows large corrections", () => {
    const clock = new PlaybackClock();
    clock.update(10_000, true, 0, true);
    // 100 ms later the engine reports 10_060 (we showed 10_100): hold, then catch up.
    clock.update(10_060, true, 100, false);
    expect(clock.now(100)).toBe(10_100);
    expect(clock.now(200)).toBe(10_160);
    // A report far behind is a real correction (e.g. after buffering).
    clock.update(8_000, true, 300, false);
    expect(clock.now(300)).toBe(8_000);
  });
});

describe("lyrics offset storage", () => {
  afterEach(() => localStorage.clear());

  it("persists per track under navify.lyrics.offset.<id>, in 0.1 s steps, clamped", () => {
    expect(getLyricsOffset("t1")).toBe(0);
    setLyricsOffset("t1", 300);
    expect(localStorage.getItem("navify.lyrics.offset.t1")).toBe("300");
    expect(getLyricsOffset("t1")).toBe(300);
    setLyricsOffset("t1", 123);
    expect(getLyricsOffset("t1")).toBe(100);
    setLyricsOffset("t1", 99_999);
    expect(getLyricsOffset("t1")).toBe(10_000);
    setLyricsOffset("t1", 0);
    expect(localStorage.getItem("navify.lyrics.offset.t1")).toBeNull();
    expect(getLyricsOffset("t2")).toBe(0);
  });
});

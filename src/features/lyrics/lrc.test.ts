import { parseLrc, parseLrcDocument, toLrc } from "./lrc";

describe("parseLrc", () => {
  it("parses centisecond, millisecond and whole-second stamps", () => {
    const lyrics = parseLrc("[00:12.34]one\n[01:02.345]two\n[02:03]three")!;
    expect(lyrics.synced).toBe(true);
    expect(lyrics.lines.map((l) => [l.startMs, l.text])).toEqual([
      [12_340, "one"],
      [62_345, "two"],
      [123_000, "three"],
    ]);
    expect(lyrics.source).toBe("lrclib");
    expect(lyrics.offsetMs).toBe(0);
  });

  it("reads a single fraction digit as deciseconds", () => {
    expect(parseLrc("[00:01.5]x")!.lines[0]!.startMs).toBe(1500);
  });

  it("repeats a line for several stamps and sorts by time", () => {
    const lyrics = parseLrc("[00:30.00][01:00.00]chorus\n[00:10.00]verse")!;
    expect(lyrics.lines.map((l) => [l.startMs, l.text])).toEqual([
      [10_000, "verse"],
      [30_000, "chorus"],
      [60_000, "chorus"],
    ]);
  });

  it("handles CRLF, a BOM and surrounding whitespace", () => {
    const lyrics = parseLrc("﻿[00:01.00]a  \r\n[00:02.00]b\r\n")!;
    expect(lyrics.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("reads metadata tags", () => {
    const { lyrics, meta } = parseLrcDocument(
      "[ar:Aurora Lane]\n[ti:Song 1]\n[al:Morning Static]\n[length:03:21]\n[la:DE]\n[00:01.00]hi",
    );
    expect(meta).toEqual({
      artist: "Aurora Lane",
      title: "Song 1",
      album: "Morning Static",
      lengthMs: 201_000,
      language: "de",
    });
    expect(lyrics!.language).toBe("de");
    expect(lyrics!.lines).toHaveLength(1);
  });

  it("keeps a positive [offset] as lines appearing earlier (displayed = start + offsetMs)", () => {
    const early = parseLrcDocument("[offset:+500]\n[00:10.00]x");
    expect(early.meta.offsetMs).toBe(500);
    expect(early.lyrics!.offsetMs).toBe(-500);
    expect(early.lyrics!.lines[0]!.startMs! + early.lyrics!.offsetMs).toBe(9_500);

    const late = parseLrc("[offset:-250]\n[00:10.00]x")!;
    expect(late.offsetMs).toBe(250);
  });

  it("keeps timed empty lines as spacers and ignores untimed blank lines", () => {
    const lyrics = parseLrc("[00:01.00]a\n\n[00:05.00]\n[00:09.00]b")!;
    expect(lyrics.lines.map((l) => l.text)).toEqual(["a", "", "b"]);
    expect(lyrics.lines[1]!.startMs).toBe(5_000);
  });

  it("parses enhanced word timing", () => {
    const lyrics = parseLrc("[00:10.00]<00:10.00>Hello <00:10.50>big <00:11.00>world<00:11.80>")!;
    const line = lyrics.lines[0]!;
    expect(line.text).toBe("Hello big world");
    expect(line.words).toEqual([
      { startMs: 10_000, endMs: 10_500, text: "Hello " },
      { startMs: 10_500, endMs: 11_000, text: "big " },
      { startMs: 11_000, endMs: 11_800, text: "world" },
    ]);
  });

  it("leaves the end of the last word open without a closing marker and shifts repeated lines", () => {
    const lyrics = parseLrc("[00:10.00][00:20.00]<00:10.00>la <00:10.40>la")!;
    expect(lyrics.lines).toHaveLength(2);
    expect(lyrics.lines[1]!.words).toEqual([
      { startMs: 20_000, endMs: 20_400, text: "la " },
      { startMs: 20_400, text: "la" },
    ]);
  });

  it("starts text in front of the first word marker at the line stamp", () => {
    const line = parseLrc("[00:05.00]Oh <00:05.50>yeah")!.lines[0]!;
    expect(line.text).toBe("Oh yeah");
    expect(line.words![0]).toEqual({ startMs: 5_000, endMs: 5_500, text: "Oh " });
  });

  it("turns text without stamps into unsynced lines", () => {
    const lyrics = parseLrc("\nfirst line\r\nsecond line\n\nthird after gap\n\n")!;
    expect(lyrics.synced).toBe(false);
    expect(lyrics.lines.map((l) => l.text)).toEqual(["first line", "second line", "", "third after gap"]);
    expect(lyrics.lines.every((l) => l.startMs === undefined)).toBe(true);
  });

  it("returns null for empty input", () => {
    expect(parseLrc("")).toBeNull();
    expect(parseLrc("[ar:Nobody]\n\n")).toBeNull();
    expect(parseLrc("[00:01.00]\n[00:02.00]")).toBeNull();
  });
});

describe("toLrc", () => {
  it("writes synced lyrics that parse back to the same lines and times", () => {
    const lyrics = parseLrc("[00:01.50]One\n[01:02.25]Two\n[offset:+100]", "lrclib")!;
    const back = parseLrc(toLrc(lyrics), "local")!;
    expect(back.synced).toBe(true);
    expect(back.offsetMs).toBe(0);
    expect(back.lines.map((l) => [l.startMs! + back.offsetMs, l.text])).toEqual(
      lyrics.lines.map((l) => [l.startMs! + lyrics.offsetMs, l.text]),
    );
  });

  it("writes unsynced lyrics as plain lines", () => {
    const lyrics = parseLrc("First line\nSecond line", "server")!;
    expect(toLrc(lyrics)).toBe("First line\nSecond line\n");
    expect(parseLrc(toLrc(lyrics), "local")?.synced).toBe(false);
  });
});

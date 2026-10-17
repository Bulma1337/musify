import type { Track } from "@/api/provider";
import { fakeTracks } from "@/test/fakeProvider";
import { setupMockServer } from "@/test/msw";
import { fetchLrclib } from "./lrclib";

const mock = setupMockServer();
const track: Track = { ...fakeTracks[0]!, durationMs: 181_400 };

const record = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  trackName: "Song 1",
  artistName: "Aurora Lane",
  albumName: "Morning Static",
  duration: 181,
  instrumental: false,
  plainLyrics: "plain one\nplain two",
  syncedLyrics: "[00:01.00]synced one\n[00:05.00]synced two",
  ...extra,
});

describe("fetchLrclib", () => {
  it("asks /api/get with track, artist, album and whole-second duration and the client header", async () => {
    mock.respond((call) => (call.endpoint === "get" ? record() : undefined));
    const original = globalThis.fetch;
    let header: string | null = null;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      header = new Headers(init?.headers).get("Lrclib-Client");
      return original(input, init);
    }) as typeof fetch;
    try {
      const result = await fetchLrclib(track);
      expect(result.lyrics?.synced).toBe(true);
      expect(result.lyrics?.source).toBe("lrclib");
      expect(result.lyrics?.lines.map((l) => l.text)).toEqual(["synced one", "synced two"]);
    } finally {
      globalThis.fetch = original;
    }

    const call = mock.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe("https://lrclib.net/api/get");
    expect(call.params.get("track_name")).toBe("Song 1");
    expect(call.params.get("artist_name")).toBe("Aurora Lane");
    expect(call.params.get("album_name")).toBe("Morning Static");
    expect(call.params.get("duration")).toBe("181");
    expect(header).toBe("Navify 0.1.0 (https://github.com/Bulma1337/navify)");
  });

  it("falls back to plain lyrics when no synced text exists", async () => {
    mock.respond(() => record({ syncedLyrics: null }));
    const result = await fetchLrclib(track);
    expect(result.lyrics?.synced).toBe(false);
    expect(result.lyrics?.lines.map((l) => l.text)).toEqual(["plain one", "plain two"]);
  });

  it("falls back to /api/search on 404 and picks a synced hit within ±3 s", async () => {
    mock.respond((call) =>
      call.endpoint === "search"
        ? [
            record({ id: 1, duration: 200, syncedLyrics: "[00:01.00]too long" }),
            record({ id: 2, duration: 182, syncedLyrics: null, plainLyrics: "plain hit" }),
            record({ id: 3, duration: 184, syncedLyrics: "[00:01.00]synced hit" }),
            record({ id: 4, duration: 185, syncedLyrics: "[00:01.00]just outside" }),
          ]
        : undefined,
    );
    const result = await fetchLrclib(track);
    expect(mock.calls.map((c) => c.endpoint)).toEqual(["get", "search"]);
    expect(mock.calls[1]!.params.get("track_name")).toBe("Song 1");
    expect(mock.calls[1]!.params.get("artist_name")).toBe("Aurora Lane");
    expect(result.lyrics?.lines[0]?.text).toBe("synced hit");
  });

  it("returns nothing when no search hit matches the duration", async () => {
    mock.respond((call) => (call.endpoint === "search" ? [record({ duration: 300 })] : undefined));
    expect(await fetchLrclib(track)).toEqual({ lyrics: null, instrumental: false });
  });

  it("respects instrumental", async () => {
    mock.respond(() => record({ instrumental: true, plainLyrics: null, syncedLyrics: null }));
    expect(await fetchLrclib(track)).toEqual({ lyrics: null, instrumental: true });
  });

  it("treats server errors as no lyrics", async () => {
    mock.respond(() => new Response("boom", { status: 500 }));
    expect(await fetchLrclib(track)).toEqual({ lyrics: null, instrumental: false });
    expect(mock.calls).toHaveLength(1);
  });
});

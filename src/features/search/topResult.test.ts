import type { SearchResult } from "@/api/provider";
import { fakeAlbums, fakeArtists, fakeTracks } from "@/test/fakeProvider";
import { pickTopResult } from "./topResult";

const all: SearchResult = { artists: fakeArtists, albums: fakeAlbums, tracks: fakeTracks };

describe("pickTopResult", () => {
  it("prefers an exact artist name, ignoring case", () => {
    expect(pickTopResult(all, "aurora lane")).toMatchObject({ type: "artist", item: { id: "ar1" } });
  });

  it("takes an exact album name before a prefix match on an artist", () => {
    expect(pickTopResult(all, "Nordlicht")).toMatchObject({ type: "album", item: { id: "al3" } });
  });

  it("falls back to a prefix match, artists first", () => {
    expect(pickTopResult(all, "kollektiv")).toMatchObject({ type: "artist", item: { id: "ar2" } });
    expect(pickTopResult({ ...all, artists: [] }, "night")).toMatchObject({
      type: "album",
      item: { id: "al2" },
    });
  });

  it("uses the first track when no name matches", () => {
    expect(pickTopResult(all, "song")).toMatchObject({ type: "track", item: { id: "t1" } });
  });

  it("returns null for empty results", () => {
    expect(pickTopResult({ artists: [], albums: [], tracks: [] }, "x")).toBeNull();
  });
});

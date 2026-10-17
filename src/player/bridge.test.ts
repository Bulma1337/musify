import { useSession } from "@/api/session";
import { OfflineProvider } from "@/features/downloads/offlineProvider";
import { resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import { createFakeProvider, fakeServer, fakeTracks } from "@/test/fakeProvider";
import { shouldScrobble, sourceLocation } from "./bridge";

vi.mock("@/features/downloads/api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

describe("shouldScrobble", () => {
  it("needs at least 30 seconds", () => {
    expect(shouldScrobble(29_000, 40_000)).toBe(false);
    expect(shouldScrobble(30_000, 40_000)).toBe(true);
  });

  it("needs half the track or four minutes", () => {
    expect(shouldScrobble(100_000, 300_000)).toBe(false);
    expect(shouldScrobble(150_000, 300_000)).toBe(true);
    expect(shouldScrobble(240_000, 900_000)).toBe(true);
  });
});

describe("sourceLocation", () => {
  const track = fakeTracks[0]!;

  beforeEach(() => {
    resetDownloads();
    useSession.setState({ provider: createFakeProvider(), status: "ready", offline: false });
  });

  it("streams tracks that are not downloaded", () => {
    expect(sourceLocation(track)).toMatchObject({
      kind: "http",
      url: "http://test.local/stream/t1",
      cacheKey: "srv1:t1:raw:0",
      allowInsecureTls: false,
    });
  });

  it("plays the downloaded file when there is one", () => {
    seedDownloads({ tracks: [trackRow(track)] });
    expect(sourceLocation(track)).toEqual({
      kind: "local",
      path: "D:/Music/Musify/Test Server/x/t1.flac",
    });
  });

  it("streams while the download is still running", () => {
    seedDownloads({ tracks: [trackRow(track, "downloading")] });
    expect(sourceLocation(track)?.kind).toBe("http");
  });

  it("plays downloads offline and skips tracks that can't be streamed", () => {
    useSession.setState({ provider: new OfflineProvider(fakeServer), offline: true });
    seedDownloads({ tracks: [trackRow(track)] });
    expect(sourceLocation(track)?.kind).toBe("local");
    expect(sourceLocation(fakeTracks[1]!)).toBeNull();
  });

  it("has nothing to play without a connection or a download", () => {
    useSession.setState({ provider: null });
    expect(sourceLocation(track)).toBeNull();
  });
});

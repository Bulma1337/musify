import { shouldScrobble } from "./bridge";

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

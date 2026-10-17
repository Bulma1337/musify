import type { Track } from "@/api/provider";
import { publicCoverUrl } from "./discordPresence";

const http = vi.hoisted(() => ({ httpRequest: vi.fn() }));
vi.mock("@/api/http", () => http);

const track = (artist: string, album: string) =>
  ({
    id: "t",
    title: "Song",
    artists: [{ id: "a", name: artist }],
    album: { id: album, name: album },
  }) as Track;

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

/** Deezer and Apple answers by URL. */
function servers(deezer: unknown, apple: unknown) {
  http.httpRequest.mockImplementation((url: string) =>
    url.startsWith("https://api.deezer.com/") ? json(deezer) : json(apple),
  );
}

afterEach(() => http.httpRequest.mockReset());

describe("public cover for Discord", () => {
  it("takes Deezer's matching album and asks only once per album", async () => {
    servers(
      {
        data: [
          { title: "Something Else", cover_xl: "https://deezer/other.jpg" },
          { title: "The Singles 86-98", cover_xl: "https://deezer/singles.jpg" },
        ],
      },
      { results: [] },
    );
    const singles = track("Depeche Mode", "The Singles 86>98");
    expect(await publicCoverUrl(singles)).toBe("https://deezer/singles.jpg");
    expect(await publicCoverUrl(singles)).toBe("https://deezer/singles.jpg");
    expect(http.httpRequest).toHaveBeenCalledTimes(1);
    // Only artist and album go to the search, never the music server's URL.
    expect(String(http.httpRequest.mock.calls[0]![0])).toMatch(
      /^https:\/\/api\.deezer\.com\/search\/album\?q=artist%3A%22Depeche%20Mode%22/,
    );
  });

  it("falls back to Apple, in a larger size", async () => {
    servers(
      { data: [] },
      {
        results: [
          { collectionName: "Nafri Trap EP, Vol. 1", artworkUrl100: "https://img/nafri/100x100bb.jpg" },
        ],
      },
    );
    expect(await publicCoverUrl(track("Kollegah", "Nafri Trap EP, Vol. 1"))).toBe(
      "https://img/nafri/512x512bb.jpg",
    );
  });

  it("gives up quietly without a match", async () => {
    servers({ data: [] }, { results: [] });
    expect(await publicCoverUrl(track("Nobody", "Unknown"))).toBeNull();
  });
});

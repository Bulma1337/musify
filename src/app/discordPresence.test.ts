import type { Track } from "@/api/provider";
import { publicCoverUrl } from "./discordPresence";

const http = vi.hoisted(() => ({ httpRequest: vi.fn() }));
vi.mock("@/api/http", () => http);

const track = (album: string) =>
  ({ id: "t", title: "Song", artists: [{ id: "a", name: "Artist" }], album: { id: album, name: album } }) as Track;

describe("public cover for Discord", () => {
  it("takes the matching album from the search, in a larger size, and asks only once", async () => {
    http.httpRequest.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { collectionName: "Other Album", artworkUrl100: "https://img/other/100x100bb.jpg" },
            { collectionName: "Nafri Trap EP, Vol. 1", artworkUrl100: "https://img/nafri/100x100bb.jpg" },
          ],
        }),
      ),
    );
    expect(await publicCoverUrl(track("Nafri Trap EP, Vol. 1"))).toBe("https://img/nafri/512x512bb.jpg");
    expect(await publicCoverUrl(track("Nafri Trap EP, Vol. 1"))).toBe("https://img/nafri/512x512bb.jpg");
    expect(http.httpRequest).toHaveBeenCalledTimes(1);
    // Only artist and album go to the search, never the music server's URL.
    expect(String(http.httpRequest.mock.calls[0]![0])).toMatch(/^https:\/\/itunes\.apple\.com\/search\?term=Artist%20Nafri/);
  });

  it("gives up quietly without a match", async () => {
    http.httpRequest.mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    expect(await publicCoverUrl(track("Unknown"))).toBeNull();
  });
});

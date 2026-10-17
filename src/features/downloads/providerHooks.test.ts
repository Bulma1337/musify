import type { Mock } from "vitest";
import { ProviderError } from "@/api/provider";
import { createFakeProvider } from "@/test/fakeProvider";
import { removeCollectionDownload, scheduleSync } from "./actions";
import { decorateProvider } from "./providerHooks";

vi.mock("./actions", () => ({
  FAVORITES_ID: "favorites",
  scheduleSync: vi.fn(),
  removeCollectionDownload: vi.fn(async () => {}),
}));

const raw = () => createFakeProvider();
let onNetworkError: Mock<() => void>;

beforeEach(() => {
  vi.clearAllMocks();
  onNetworkError = vi.fn<() => void>();
});

describe("decorateProvider", () => {
  it("behaves like the wrapped provider", async () => {
    const provider = decorateProvider(raw(), { onNetworkError });
    expect(provider.server.id).toBe("srv1");
    expect(provider.capabilities.lyrics).toBe(true);
    expect((await provider.getAlbum("al1")).name).toBe("Morning Static");
    // Synchronous methods stay synchronous.
    expect(provider.coverUrl("al1", 64)).toBe("http://test.local/cover/al1?size=64");
    expect(provider.getStreamSource(await provider.getTrack("t1")).url).toContain("/stream/t1");
    expect(onNetworkError).not.toHaveBeenCalled();
  });

  it("reports network and timeout errors and still rejects", async () => {
    const base = raw();
    vi.spyOn(base, "getAlbum").mockRejectedValue(new ProviderError("network", "down"));
    vi.spyOn(base, "getArtist").mockRejectedValue(new ProviderError("timeout", "slow"));
    const provider = decorateProvider(base, { onNetworkError });
    await expect(provider.getAlbum("al1")).rejects.toMatchObject({ kind: "network" });
    await expect(provider.getArtist("ar1")).rejects.toMatchObject({ kind: "timeout" });
    expect(onNetworkError).toHaveBeenCalledTimes(2);
  });

  it("ignores other errors", async () => {
    const provider = decorateProvider(raw(), { onNetworkError });
    await expect(provider.getAlbum("missing")).rejects.toMatchObject({ kind: "notFound" });
    expect(onNetworkError).not.toHaveBeenCalled();
  });

  it("syncs the favorites after a track was starred or unstarred", async () => {
    const base = raw();
    const provider = decorateProvider(base, { onNetworkError });
    await provider.setStarred("track", "t1", true);
    expect(scheduleSync).toHaveBeenCalledWith(base, "favorites", "favorites");
    vi.mocked(scheduleSync).mockClear();
    await provider.setStarred("album", "al1", true);
    expect(scheduleSync).not.toHaveBeenCalled();
  });

  it("syncs a playlist after it was changed", async () => {
    const base = raw();
    const provider = decorateProvider(base, { onNetworkError });
    await provider.addToPlaylist("pl1", ["t2"]);
    await provider.removeFromPlaylist("pl1", [0]);
    await provider.updatePlaylist("pl1", { name: "x" });
    await provider.reorderPlaylist("pl1", []);
    expect(vi.mocked(scheduleSync).mock.calls.map((c) => c.slice(1))).toEqual([
      ["playlist", "pl1"],
      ["playlist", "pl1"],
      ["playlist", "pl1"],
      ["playlist", "pl1"],
    ]);
  });

  it("drops the download of a deleted playlist", async () => {
    const provider = decorateProvider(raw(), { onNetworkError });
    await provider.deletePlaylist("pl1");
    expect(removeCollectionDownload).toHaveBeenCalledWith("srv1", "playlist", "pl1");
  });

  it("does not sync when the change failed", async () => {
    const base = raw();
    vi.spyOn(base, "addToPlaylist").mockRejectedValue(new ProviderError("server", "no", 500));
    const provider = decorateProvider(base, { onNetworkError });
    await expect(provider.addToPlaylist("pl1", ["t2"])).rejects.toBeInstanceOf(ProviderError);
    expect(scheduleSync).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useSession } from "@/api/session";
import { useToasts } from "@/components/ui/toast";
import { AlbumPage } from "@/features/album/AlbumPage";
import { LikedPage } from "@/features/liked/LikedPage";
import { PlaylistPage } from "@/features/playlist/PlaylistPage";
import { fakeAlbums, fakePlaylists, fakeTracks } from "@/test/fakeProvider";
import { collectionRow, resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import { renderPage } from "@/test/renderPage";
import { downloadsApi } from "./api";
import { FAVORITES_ID } from "./actions";
import { useDownloads } from "./store";
import type { DownloadUpdate } from "./types";

vi.mock("./api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const albumTracks = fakeTracks.filter((t) => t.album?.id === "al1"); // t1, t2, t3
const albumCollection = () =>
  collectionRow("album", "al1", "Morning Static", { kind: "album", album: fakeAlbums[0]! }, [
    "t1",
    "t2",
    "t3",
  ]);

function renderAlbum() {
  return renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al1" });
}

const toggle = (name: RegExp | string) => screen.findByRole("button", { name });

function progress(trackId: string, patch: Partial<DownloadUpdate>): DownloadUpdate {
  return {
    serverId: "srv1",
    trackId,
    state: "downloading",
    bytesDone: 0,
    bytesTotal: null,
    error: null,
    path: null,
    sizeBytes: 0,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  resetDownloads();
  useSession.setState({ offline: false });
});

describe("download toggle in page headers", () => {
  it("downloads the album on click and shows the progress while it runs", async () => {
    renderAlbum();
    fireEvent.click(await toggle("Download"));

    await waitFor(() => expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1));
    const [collection, jobs] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection).toMatchObject({ kind: "album", itemId: "al1", trackIds: ["t1", "t2", "t3"] });
    expect(jobs).toHaveLength(3);

    // One track is done and one is half way: 1.5 of 3 tracks.
    act(() => {
      useDownloads
        .getState()
        .applyUpdates([
          progress("t1", { state: "done", path: "D:/a.flac", sizeBytes: 10 }),
          progress("t2", { bytesDone: 5, bytesTotal: 10 }),
        ]);
    });
    expect(await toggle(/Downloading, 50 %/)).toBeInTheDocument();
  });

  it("shows the finished state and removes the download on click", async () => {
    seedDownloads({ tracks: albumTracks.map((t) => trackRow(t)), collections: [albumCollection()] });
    renderAlbum();
    fireEvent.click(await toggle(/^Downloaded\./));
    await waitFor(() => expect(downloadsApi.removeCollection).toHaveBeenCalledWith("srv1", "album", "al1"));
  });

  it("cancels while the album is still downloading", async () => {
    seedDownloads({
      tracks: [
        trackRow(albumTracks[0]!),
        trackRow(albumTracks[1]!, "queued"),
        trackRow(albumTracks[2]!, "queued"),
      ],
      collections: [albumCollection()],
    });
    renderAlbum();
    fireEvent.click(await toggle(/^Downloading/));
    await waitFor(() => expect(downloadsApi.removeCollection).toHaveBeenCalledWith("srv1", "album", "al1"));
  });

  it("offers a retry when some tracks failed", async () => {
    seedDownloads({
      tracks: [trackRow(albumTracks[0]!), trackRow(albumTracks[1]!, "failed"), trackRow(albumTracks[2]!)],
      collections: [albumCollection()],
    });
    renderAlbum();
    fireEvent.click(await toggle(/could not be downloaded/));
    await waitFor(() => expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1));
    const [, jobs] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(jobs.map((j) => j.trackId)).toEqual(["t2"]);
  });

  it("is hidden where downloads are not available (browser preview)", async () => {
    resetDownloads(false);
    renderAlbum();
    await screen.findByRole("heading", { name: "Morning Static" });
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });

  it("is disabled offline unless the album is already downloaded", async () => {
    renderAlbum();
    useSession.setState({ offline: true });
    const button = await toggle(/needs a connection/);
    expect(button).toBeDisabled();
  });

  it("works for playlists", async () => {
    renderPage(<PlaylistPage />, { path: "/playlist/:id", url: "/playlist/pl1" });
    fireEvent.click(await toggle("Download"));
    await waitFor(() => expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1));
    const [collection] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection).toMatchObject({ kind: "playlist", itemId: "pl1", name: "Road Trip" });
    expect(collection.trackIds).toEqual(fakePlaylists[0]!.tracks.map((t) => t.id));
  });

  it("works for the favorites", async () => {
    renderPage(<LikedPage />, { path: "/liked", url: "/liked" });
    fireEvent.click(await toggle("Download"));
    await waitFor(() => expect(downloadsApi.setCollection).toHaveBeenCalledTimes(1));
    const [collection] = vi.mocked(downloadsApi.setCollection).mock.calls[0]!;
    expect(collection).toMatchObject({ kind: "favorites", itemId: FAVORITES_ID });
    expect(collection.trackIds).toEqual(expect.arrayContaining(["t4", "t8"]));
  });
});

describe("downloaded marker and track menu", () => {
  it("marks downloaded tracks in the list", async () => {
    seedDownloads({ tracks: [trackRow(albumTracks[0]!), trackRow(albumTracks[1]!, "queued")] });
    renderAlbum();
    await screen.findByText("Song 1");
    expect(screen.getAllByTitle("Downloaded")).toHaveLength(1);
    expect(screen.getAllByTitle("Waiting to download")).toHaveLength(1);
  });

  it("downloads a track from its context menu", async () => {
    renderAlbum();
    fireEvent.contextMenu(await screen.findByText("Song 2"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(downloadsApi.enqueue).toHaveBeenCalledTimes(1));
    const [jobs] = vi.mocked(downloadsApi.enqueue).mock.calls[0]!;
    expect(jobs).toEqual([expect.objectContaining({ trackId: "t2", individual: true })]);
  });

  it("removes the download of an already downloaded track", async () => {
    seedDownloads({ tracks: [trackRow(albumTracks[1]!, "done", { individual: true })] });
    renderAlbum();
    fireEvent.contextMenu(await screen.findByText("Song 2"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove download" }));
    await waitFor(() => expect(downloadsApi.removeTrack).toHaveBeenCalledWith("srv1", "t2"));
  });

  it("explains why a track stays when a downloaded collection holds it", async () => {
    vi.mocked(downloadsApi.removeTrack).mockResolvedValueOnce(false);
    seedDownloads({ tracks: [trackRow(albumTracks[1]!)] });
    renderAlbum();
    fireEvent.contextMenu(await screen.findByText("Song 2"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove download" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
        expect.stringMatching(/Part of a downloaded album/),
      ]),
    );
  });

  it("disables the server-only entries offline, but not the download removal", async () => {
    seedDownloads({ tracks: [trackRow(albumTracks[1]!)] });
    renderAlbum();
    useSession.setState({ offline: true });
    fireEvent.contextMenu(await screen.findByText("Song 2"));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: /Add to favorites|Remove from favorites/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Remove download" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

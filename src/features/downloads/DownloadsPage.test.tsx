import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { LibrarySidebar } from "@/app/layout/LibrarySidebar";
import { useSession } from "@/api/session";
import { useToasts } from "@/components/ui/toast";
import { useSettings } from "@/settings/store";
import { fakeAlbums, fakePlaylists, fakeTracks } from "@/test/fakeProvider";
import { collectionRow, resetDownloads, seedDownloads, trackRow } from "@/test/downloads";
import { renderPage } from "@/test/renderPage";
import { cacheApi, downloadsApi } from "./api";
import { DownloadsPage } from "./DownloadsPage";
import { OfflineBanner } from "./OfflineBanner";
import { StorageSettings } from "./StorageSettings";
import { useDownloads } from "./store";

vi.mock("./api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));

const track = (id: string) => fakeTracks.find((t) => t.id === id)!;
const { tracks: _playlistTracks, ...playlistInfo } = fakePlaylists[0]!;

beforeEach(() => {
  vi.resetAllMocks();
  resetDownloads();
  useToasts.setState({ toasts: [] });
  useSession.setState({ offline: false, reconnecting: false });
  useSettings.setState({ cacheLimitGb: 2 });
});

function renderDownloads() {
  return renderPage(<DownloadsPage />, { path: "/downloads", url: "/downloads" });
}

describe("downloads page", () => {
  it("explains how to get started when nothing is downloaded", async () => {
    renderDownloads();
    expect(await screen.findByRole("heading", { name: "Nothing downloaded yet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });

  it("says what to do offline when nothing is downloaded", async () => {
    useSession.setState({ offline: true });
    renderDownloads();
    expect(await screen.findByRole("heading", { name: "Nothing to play offline" })).toBeInTheDocument();
  });

  it("says that downloads need the desktop app in the browser preview", async () => {
    resetDownloads(false);
    renderDownloads();
    expect(await screen.findByText("Downloads are only available in the desktop app.")).toBeInTheDocument();
    expect(screen.getByText("Storage settings are only available in the desktop app.")).toBeInTheDocument();
  });

  function seedBusyLibrary() {
    seedDownloads({
      tracks: [
        trackRow(track("t1")),
        trackRow(track("t2")),
        trackRow(track("t3"), "downloading"),
        trackRow(track("t4"), "queued"),
        trackRow(track("t5"), "failed"),
      ],
      collections: [
        collectionRow("album", "al1", "Morning Static", { kind: "album", album: fakeAlbums[0]! }, [
          "t1",
          "t2",
          "t3",
        ]),
        collectionRow("playlist", "pl1", "Road Trip", { kind: "playlist", playlist: playlistInfo }, ["t1"]),
        collectionRow("favorites", "favorites", "Favorites", { kind: "favorites" }, ["t2"]),
      ],
    });
    act(() => {
      useDownloads.getState().applyUpdates([
        {
          serverId: "srv1",
          trackId: "t3",
          state: "downloading",
          bytesDone: 25,
          bytesTotal: 100,
          error: null,
          path: null,
          sizeBytes: 0,
        },
      ]);
    });
  }

  it("lists running, failed and finished downloads and the downloaded collections", async () => {
    seedBusyLibrary();
    renderDownloads();

    const active = (await screen.findByRole("heading", { name: /In progress/ })).closest("section")!;
    expect(within(active).getByText("Song 3")).toBeInTheDocument();
    expect(within(active).getByText("Song 4")).toBeInTheDocument();
    expect(within(active).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(within(active).getByText("25 %")).toBeInTheDocument();
    expect(within(active).getByText("Waiting")).toBeInTheDocument();

    const failed = screen.getByRole("heading", { name: /Failed/ }).closest("section")!;
    expect(within(failed).getByText("Song 5")).toBeInTheDocument();
    expect(within(failed).getByText("HTTP status 500")).toBeInTheDocument();

    const collections = screen
      .getByRole("heading", { name: "Albums, playlists and favorites" })
      .closest("section")!;
    for (const name of ["Morning Static", "Road Trip", "Favorites"]) {
      expect(within(collections).getByText(name)).toBeInTheDocument();
    }

    const tracks = screen.getByRole("heading", { name: /Downloaded tracks/ }).closest("section")!;
    expect(within(tracks).getByText("Song 1")).toBeInTheDocument();
    expect(within(tracks).queryByText("Song 3")).not.toBeInTheDocument();
    expect(screen.getByText("2 tracks • 57.2 MB")).toBeInTheDocument();
  });

  it("cancels a running download", async () => {
    seedBusyLibrary();
    renderDownloads();
    const row = (await screen.findByText("Song 3")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(downloadsApi.cancel).toHaveBeenCalledWith("srv1", ["t3"]));
    expect(screen.queryByText("Song 3")).not.toBeInTheDocument();
  });

  it("retries failed downloads one by one or all at once", async () => {
    seedBusyLibrary();
    renderDownloads();
    const row = (await screen.findByText("Song 5")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(downloadsApi.enqueue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadsApi.enqueue).mock.calls[0]![0]).toEqual([
      expect.objectContaining({ trackId: "t5" }),
    ]);
    // Song 5 is queued again now, so nothing is left to retry.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Try all again" })).not.toBeInTheDocument(),
    );
  });

  it("removes a failed download", async () => {
    seedBusyLibrary();
    renderDownloads();
    const row = (await screen.findByText("Song 5")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(downloadsApi.cancel).toHaveBeenCalledWith("srv1", ["t5"]));
  });

  it("disables retrying while offline", async () => {
    seedBusyLibrary();
    useSession.setState({ offline: true });
    renderDownloads();
    const row = (await screen.findByText("Song 5")).closest("li")!;
    expect(within(row).getByRole("button", { name: "Try again" })).toBeDisabled();
  });
});

/** The storage buttons stay disabled until the sizes have been read. */
async function enabledButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("storage settings", () => {
  it("shows the folder and the sizes of downloads and cache", async () => {
    render();
    expect(await screen.findByText("D:/Music/Musify")).toBeInTheDocument();
    expect(await screen.findByText(/118 MB • 3 tracks/)).toBeInTheDocument();
    expect(await screen.findByText("50 MB")).toBeInTheDocument();
  });

  function render() {
    return renderPage(<StorageSettings />);
  }

  it("clears the cache", async () => {
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));
    await waitFor(() => expect(cacheApi.clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toContain("Cache cleared"));
  });

  it("changes the cache limit", async () => {
    render();
    const radios = await screen.findAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["1 GB", "2 GB", "5 GB", "10 GB"]);
    expect(screen.getByRole("radio", { name: "2 GB" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "5 GB" }));
    expect(useSettings.getState().cacheLimitGb).toBe(5);
    expect(screen.getByRole("radio", { name: "5 GB" })).toBeChecked();
  });

  it("removes all downloads only after confirmation", async () => {
    render();
    fireEvent.click(await enabledButton("Remove all downloads"));
    const dialog = await screen.findByRole("alertdialog");
    expect(downloadsApi.removeAll).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(downloadsApi.removeAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove all downloads" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove all downloads" }),
    );
    await waitFor(() => expect(downloadsApi.removeAll).toHaveBeenCalledTimes(1));
  });

  it("moves the downloads to a chosen folder and shows the progress", async () => {
    vi.mocked(openFolderDialog).mockResolvedValue("E:/Music/New");
    let finish: () => void = () => {};
    vi.mocked(downloadsApi.setDir).mockImplementation(async (_dir, onProgress) => {
      onProgress({ movedBytes: 10, totalBytes: 40, movedFiles: 1, totalFiles: 4, done: false });
      await new Promise<void>((resolve) => (finish = resolve));
    });
    render();
    fireEvent.click(await enabledButton("Change folder"));

    expect(await screen.findByText("Moving files … 1 of 4")).toBeInTheDocument();
    expect(downloadsApi.setDir).toHaveBeenCalledWith("E:/Music/New", expect.any(Function));
    expect(screen.getByRole("button", { name: "Change folder" })).toBeDisabled();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText(/Moving files/)).not.toBeInTheDocument());
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain("Downloads folder changed");
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    vi.mocked(openFolderDialog).mockResolvedValue(null);
    render();
    fireEvent.click(await enabledButton("Change folder"));
    await waitFor(() => expect(openFolderDialog).toHaveBeenCalled());
    expect(downloadsApi.setDir).not.toHaveBeenCalled();
  });

  it("explains that the folder can't change while downloads are running", async () => {
    vi.mocked(downloadsApi.storageInfo).mockResolvedValue({
      dir: "D:/Music/Musify",
      downloadsBytes: 1,
      trackCount: 1,
      busy: true,
    });
    render();
    expect(await screen.findByRole("button", { name: "Change folder" })).toBeDisabled();
  });

  it("reports a failed move", async () => {
    vi.mocked(openFolderDialog).mockResolvedValue("E:/Music/New");
    vi.mocked(downloadsApi.setDir).mockRejectedValue("busy");
    render();
    fireEvent.click(await enabledButton("Change folder"));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.message)).toContain(
        "Wait until the running downloads have finished.",
      ),
    );
  });
});

describe("offline banner", () => {
  it("only shows up offline and offers to reconnect", async () => {
    const retryNow = vi.fn(async () => {});
    renderPage(<OfflineBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => useSession.setState({ offline: true, retryNow }));
    expect(
      await screen.findByText("You're offline. Only downloaded music is available."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(retryNow).toHaveBeenCalledTimes(1);

    act(() => useSession.setState({ reconnecting: true }));
    expect(screen.getByRole("button", { name: /Connecting/ })).toBeDisabled();
  });
});

describe("library filter 'Downloaded'", () => {
  function seedCollections() {
    seedDownloads({
      tracks: [trackRow(track("t7")), trackRow(track("t1"))],
      collections: [
        collectionRow("playlist", "pl1", "Road Trip", { kind: "playlist", playlist: playlistInfo }, ["t1"]),
        // Not a saved album on the server, only downloaded.
        collectionRow("album", "al3", "Nordlicht", { kind: "album", album: fakeAlbums[2]! }, ["t7"]),
      ],
    });
  }

  async function titles() {
    const nav = await screen.findByRole("navigation", { name: "Library" });
    return within(nav)
      .getAllByRole("link")
      .map((link) => link.querySelector("p")?.textContent);
  }

  it("shows only what is on this computer, including albums that are not saved on the server", async () => {
    seedCollections();
    renderPage(<LibrarySidebar />);
    await screen.findByText("Aurora Lane");
    expect(await titles()).toContain("Aurora Lane");

    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    expect(screen.getByRole("button", { name: "Downloaded" })).toHaveAttribute("aria-pressed", "true");
    expect(await titles()).toEqual(["Road Trip", "Nordlicht"]);

    fireEvent.click(screen.getByRole("button", { name: "Albums" }));
    expect(await titles()).toEqual(["Nordlicht"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(await titles()).toContain("Aurora Lane");
  });

  it("has no such filter in the browser preview", async () => {
    resetDownloads(false);
    renderPage(<LibrarySidebar />);
    await titles();
    expect(screen.queryByRole("button", { name: "Downloaded" })).not.toBeInTheDocument();
  });

  it("lists the downloaded playlists and the favorites of an offline library without the server", async () => {
    seedDownloads({
      tracks: [trackRow(track("t1"))],
      collections: [
        collectionRow("playlist", "pl1", "Road Trip", { kind: "playlist", playlist: playlistInfo }, ["t1"]),
        collectionRow("favorites", "favorites", "Favorites", { kind: "favorites" }, ["t1"]),
      ],
    });
    renderPage(<LibrarySidebar />);
    fireEvent.click(await screen.findByRole("button", { name: "Downloaded" }));
    expect(await titles()).toEqual(["Favorites", "Road Trip"]);
  });
});

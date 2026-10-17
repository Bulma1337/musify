import { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LibrarySidebar } from "@/app/layout/LibrarySidebar";
import { TRACKS_MIME, type DraggedTracks } from "@/lib/dnd";
import { renderPage } from "@/test/renderPage";
import { LIBRARY_ENTRY_MIME } from "./libraryDnd";
import { useLibrary } from "./libraryStore";

beforeEach(() => useLibrary.setState({ byServer: {} }));

function renderSidebar() {
  return renderPage(<LibrarySidebar />);
}

/** Titles of the sidebar links, in display order. */
async function order() {
  const nav = await screen.findByRole("navigation", { name: "Library" });
  await screen.findByText("Road Trip");
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.querySelector("p")?.textContent);
}

function dataTransfer(type: string, data: string) {
  return { types: [type], getData: (t: string) => (t === type ? data : ""), dropEffect: "none" };
}

const payload = (trackIds: string[], origin = "album:al3"): DraggedTracks => ({
  trackIds,
  origin,
  indices: trackIds.map((_, i) => i),
});

describe("LibrarySidebar", () => {
  it("lists Favorites first, then the rest by recency", async () => {
    renderSidebar();
    expect(await order()).toEqual(["Favorites", "Road Trip", "Morning Static", "Aurora Lane"]);
  });

  it("shows pinned entries right after Favorites in pin order, with a pin icon", async () => {
    useLibrary.setState({ byServer: { srv1: { pinned: ["ar:ar1", "al:al1"], folders: [] } } });
    renderSidebar();
    expect(await order()).toEqual(["Favorites", "Aurora Lane", "Morning Static", "Road Trip"]);
    expect(screen.getAllByLabelText("Pinned")).toHaveLength(3); // Favorites and the two pins
  });

  it("pins through the context menu", async () => {
    renderSidebar();
    await order();
    fireEvent.contextMenu(screen.getByRole("link", { name: /^Aurora Lane/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(useLibrary.getState().byServer.srv1?.pinned).toEqual(["ar:ar1"]));
  });

  it("shows folder children below the folder and collapses them", async () => {
    useLibrary.setState({
      byServer: {
        srv1: { pinned: [], folders: [{ id: "f1", name: "Trips", entryKeys: ["p:pl1"], collapsed: false }] },
      },
    });
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Trips/ });
    await order();
    expect(folder).toHaveTextContent("1 playlist");
    const nav = screen.getByRole("navigation", { name: "Library" });
    const rows = Array.from(nav.children).map((c) => c.textContent ?? "");
    expect(rows[1]).toContain("Trips");
    expect(rows[2]).toContain("Road Trip");

    fireEvent.click(folder);
    await waitFor(() => expect(screen.queryByText("Road Trip")).not.toBeInTheDocument());
    expect(folder).toHaveAttribute("aria-expanded", "false");
  });

  it("renames a folder inline and deletes it through the context menu", async () => {
    useLibrary.setState({
      byServer: {
        srv1: { pinned: [], folders: [{ id: "f1", name: "Trips", entryKeys: ["p:pl1"], collapsed: false }] },
      },
    });
    renderSidebar();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /Trips/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "Holidays" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("button", { name: /Holidays/ })).toBeInTheDocument();
    expect(useLibrary.getState().byServer.srv1?.folders[0]?.name).toBe("Holidays");

    fireEvent.contextMenu(screen.getByRole("button", { name: /Holidays/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete folder" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Holidays/ })).not.toBeInTheDocument());
    // The playlist is back on the top level.
    expect(await order()).toContain("Road Trip");
  });

  it("lists matches flat while searching", async () => {
    useLibrary.setState({
      byServer: {
        srv1: { pinned: [], folders: [{ id: "f1", name: "Trips", entryKeys: ["p:pl1"], collapsed: false }] },
      },
    });
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Search library" }));
    fireEvent.change(screen.getByPlaceholderText("Search library"), { target: { value: "road" } });
    expect(await order()).toEqual(["Road Trip"]);
    expect(screen.queryByText("Trips")).not.toBeInTheDocument();
  });

  it("moves a playlist into a folder when its row is dropped on the folder", async () => {
    const id = useLibrary.getState().createFolder("srv1", "Trips");
    renderSidebar();
    const folder = await screen.findByRole("button", { name: /Trips/ });
    const dt = dataTransfer(LIBRARY_ENTRY_MIME, "p:pl1");
    const over = createEvent.dragOver(folder, { dataTransfer: dt });
    fireEvent(folder, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(folder, { dataTransfer: dt });
    expect(useLibrary.getState().byServer.srv1?.folders.find((f) => f.id === id)?.entryKeys).toEqual([
      "p:pl1",
    ]);
  });

  it("adds dropped tracks to a playlist and refreshes it", async () => {
    const { provider, queryClient } = renderSidebar();
    await order();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const row = screen.getByRole("link", { name: /Road Trip/ });
    const dt = dataTransfer(TRACKS_MIME, JSON.stringify(payload(["t7", "t8"])));

    const over = createEvent.dragOver(row, { dataTransfer: dt });
    fireEvent(row, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(row, { dataTransfer: dt });

    await waitFor(() =>
      expect(provider.calls.filter((c) => c.method === "addToPlaylist")).toEqual([
        { method: "addToPlaylist", args: ["pl1", ["t7", "t8"]] },
      ]),
    );
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["srv1", "playlist", "pl1"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["srv1", "playlists"] });
    });
  });

  it("does not accept track drops on albums and artists", async () => {
    const { provider } = renderSidebar();
    await order();
    const row = screen.getByRole("link", { name: /Morning Static/ });
    const dt = dataTransfer(TRACKS_MIME, JSON.stringify(payload(["t7"])));
    const over = createEvent.dragOver(row, { dataTransfer: dt });
    fireEvent(row, over);
    expect(over.defaultPrevented).toBe(false);
    fireEvent.drop(row, { dataTransfer: dt });
    expect(provider.calls).toEqual([]);
  });

  it("stars the tracks dropped on Favorites", async () => {
    const { provider } = renderSidebar();
    await order();
    const row = screen.getByRole("link", { name: /Favorites/ });
    fireEvent.drop(row, { dataTransfer: dataTransfer(TRACKS_MIME, JSON.stringify(payload(["t1", "t2"]))) });
    await waitFor(() =>
      expect(provider.calls.filter((c) => c.method === "setStarred")).toEqual([
        { method: "setStarred", args: ["track", "t1", true] },
        { method: "setStarred", args: ["track", "t2", true] },
      ]),
    );
  });
});

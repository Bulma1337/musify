import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { PlaylistPage } from "./PlaylistPage";

const render = () => renderPage(<PlaylistPage />, { path: "/playlist/:id", url: "/playlist/pl1" });

describe("PlaylistPage", () => {
  it("shows the playlist and its tracks", async () => {
    render();
    expect(await screen.findByRole("heading", { name: "Road Trip" })).toBeInTheDocument();
    expect(screen.getByText("Private playlist")).toBeInTheDocument();
    expect(screen.getByText("Songs for the highway")).toBeInTheDocument();
    expect(await screen.findByText("Song 1")).toBeInTheDocument();
    expect(screen.getByText("Song 9")).toBeInTheDocument();
  });

  it("filters tracks inside the playlist", async () => {
    render();
    await screen.findByText("Song 1");
    fireEvent.change(screen.getByLabelText("Filter within playlist"), { target: { value: "Song 9" } });
    expect(screen.queryByText("Song 1")).not.toBeInTheDocument();
    expect(screen.getByText("Song 9")).toBeInTheDocument();
  });

  it("saves edited details through the provider", async () => {
    const { provider } = render();
    fireEvent.click(await screen.findByRole("heading", { name: "Road Trip" }));
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Night Trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(provider.calls).toContainEqual({
        method: "updatePlaylist",
        args: ["pl1", { name: "Night Trip", comment: "Songs for the highway" }],
      }),
    );
  });

  it("removes a track from the playlist via the context menu", async () => {
    const { provider } = render();
    const row = await screen.findByText("Song 7");
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Remove from this playlist"));
    await waitFor(() =>
      expect(provider.calls).toContainEqual({ method: "removeFromPlaylist", args: ["pl1", [2]] }),
    );
  });
});

import { fireEvent, screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { usePlayer } from "@/player/store";
import { AlbumPage } from "./AlbumPage";

describe("AlbumPage", () => {
  it("renders title, tracks and disc separator", async () => {
    renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    expect(await screen.findByRole("heading", { name: "Night Drive" })).toBeInTheDocument();
    expect(await screen.findByText("Song 4")).toBeInTheDocument();
    expect(await screen.findByText(/^(CD|Disc) 2$/)).toBeInTheDocument();
    expect(screen.getByText("FLAC 16/44.1")).toBeInTheDocument();
  });

  it("plays the album from the header play button", async () => {
    renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    await screen.findByText("Song 4");
    fireEvent.click(screen.getAllByRole("button", { name: "Play" })[0]!);
    await vi.waitFor(() => expect(usePlayer.getState().context).toMatchObject({ type: "album", id: "al2" }));
  });

  it("adds the album to the library from the ... menu", async () => {
    const { provider } = renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    await screen.findByText("Song 4");
    // The album's own menu comes before the track rows' menus.
    fireEvent.pointerDown(screen.getAllByRole("button", { name: "More options" })[0]!, {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add to library" }));
    await vi.waitFor(() =>
      expect(provider.calls).toContainEqual({ method: "setStarred", args: ["album", "al2", true] }),
    );
  });

  it("lights the shuffle button while shuffle is on and turns it off again", async () => {
    usePlayer.setState({ shuffle: "off" });
    renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    await screen.findByText("Song 4");
    fireEvent.click(screen.getByRole("button", { name: "Shuffle play" }));
    await vi.waitFor(() => expect(usePlayer.getState().context).toMatchObject({ type: "album", id: "al2" }));
    expect(usePlayer.getState().shuffle).toBe("shuffle");
    const lit = screen.getByRole("button", { name: "Disable shuffle" });
    expect(lit).toHaveClass("text-accent");

    fireEvent.click(lit);
    expect(usePlayer.getState().shuffle).toBe("off");
    // Still the same album playing; nothing restarted.
    expect(usePlayer.getState().context).toMatchObject({ type: "album", id: "al2" });
    expect(screen.getByRole("button", { name: "Shuffle play" })).not.toHaveClass("text-accent");
  });

  it("shows more albums of the artist", async () => {
    renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    expect(await screen.findByText("Morning Static")).toBeInTheDocument();
  });
});

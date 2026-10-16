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

  it("shows more albums of the artist", async () => {
    renderPage(<AlbumPage />, { path: "/album/:id", url: "/album/al2" });
    expect(await screen.findByText("Morning Static")).toBeInTheDocument();
  });
});

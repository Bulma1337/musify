import { fireEvent, screen } from "@testing-library/react";
import type { Album } from "@/api/provider";
import { renderPage } from "@/test/renderPage";
import { AlbumSubtitle } from "./AlbumSubtitle";
import { MediaCard } from "./MediaCard";

const album = {
  id: "al9",
  serverId: "srv1",
  name: "Nafri Trap EP, Vol. 1",
  year: 2018,
  artists: [
    { id: "ar1", name: "Kollegah" },
    { id: "ar2", name: "Farid Bang" },
  ],
  artistLine: "Kollegah & Farid Bang",
} as Album;

function renderCard() {
  return renderPage(
    <MediaCard title={album.name} subtitle={<AlbumSubtitle album={album} />} to={`/album/${album.id}`} />,
  );
}

describe("AlbumSubtitle", () => {
  it("shows year and artists like before", () => {
    renderCard();
    expect(screen.getByText("2018").parentElement).toHaveTextContent("2018 • Kollegah & Farid Bang");
  });

  it("opens the artist, not the album, when an artist name is clicked", () => {
    const { router } = renderCard();
    fireEvent.click(screen.getByRole("link", { name: "Farid Bang" }));
    expect(router.state.location.pathname).toBe("/artist/ar2");
  });

  it("still opens the album when the rest of the card is clicked", () => {
    const { router } = renderCard();
    fireEvent.click(screen.getByText(album.name));
    expect(router.state.location.pathname).toBe("/album/al9");
  });
});

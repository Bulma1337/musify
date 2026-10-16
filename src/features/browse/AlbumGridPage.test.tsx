import { screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { AlbumGridPage } from "./AlbumGridPage";

describe("AlbumGridPage", () => {
  it("renders album cards for a list type", async () => {
    renderPage(<AlbumGridPage />, { path: "/albums/:type", url: "/albums/recentlyAdded" });
    expect(await screen.findByText("Morning Static")).toBeInTheDocument();
    expect(screen.getByText("Night Drive")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New on your server");
  });

  it("shows a message for unknown types", async () => {
    renderPage(<AlbumGridPage />, { path: "/albums/:type", url: "/albums/nonsense" });
    expect(await screen.findByText(/does not exist/)).toBeInTheDocument();
  });
});

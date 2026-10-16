import { fireEvent, screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { ArtistPage } from "./ArtistPage";
import { stripHtml } from "./stripHtml";

describe("ArtistPage", () => {
  it("renders name, popular tracks and discography", async () => {
    renderPage(<ArtistPage />, { path: "/artist/:id", url: "/artist/ar1" });
    expect(await screen.findByRole("heading", { name: "Aurora Lane" })).toBeInTheDocument();
    expect(await screen.findByText("Song 1")).toBeInTheDocument();
    expect(screen.getByText("Popular")).toBeInTheDocument();
    expect(await screen.findByText("Morning Static")).toBeInTheDocument();
    expect(screen.getByText("Night Drive")).toBeInTheDocument();
    expect(screen.getByText("Biography of Aurora Lane.")).toBeInTheDocument();
    expect(screen.getByText("Kollektiv Nord")).toBeInTheDocument();
  });

  it("filters the discography", async () => {
    renderPage(<ArtistPage />, { path: "/artist/:id", url: "/artist/ar1" });
    await screen.findByText("Morning Static");
    fireEvent.click(screen.getByRole("button", { name: "Singles and EPs" }));
    expect(screen.queryByText("Morning Static")).not.toBeInTheDocument();
    expect(screen.getByText(/No releases/)).toBeInTheDocument();
  });

  it("strips HTML from biographies", () => {
    expect(stripHtml("<p>Hello <a href='x'>world</a></p>")).toBe("Hello world");
  });
});

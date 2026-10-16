import { screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { GenrePage } from "./GenrePage";
import { genreColor } from "./genreColor";

describe("GenrePage", () => {
  it("renders the genre header, albums and tracks", async () => {
    renderPage(<GenrePage />, { path: "/genre/:name", url: "/genre/Electronic" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Electronic");
    expect((await screen.findAllByText("Song 1")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Nordlicht")).length).toBeGreaterThan(0);
    expect(screen.getByText("Popular albums")).toBeInTheDocument();
  });

  it("derives a stable color from the name", () => {
    expect(genreColor("Jazz")).toEqual(genreColor("jazz"));
    expect(genreColor("Jazz")).not.toEqual(genreColor("Metal"));
  });
});

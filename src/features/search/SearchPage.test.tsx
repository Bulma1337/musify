import { screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { SearchPage } from "./SearchPage";

describe("SearchPage", () => {
  it("shows genre tiles without a query", async () => {
    renderPage(<SearchPage />, { path: "/search", url: "/search" });
    const tile = await screen.findByRole("link", { name: /Electronic/ });
    expect(tile).toHaveAttribute("href", "/genre/Electronic");
  });

  it("shows results for a query", async () => {
    renderPage(<SearchPage />, { path: "/search", url: "/search?q=song" });
    expect(await screen.findByText("Top result")).toBeInTheDocument();
    expect(screen.getAllByText("Song 1").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Songs" })).toBeInTheDocument();
  });

  it("explains when nothing matches", async () => {
    renderPage(<SearchPage />, { path: "/search", url: "/search?q=zzzz" });
    expect(await screen.findByText(/Nothing found for/)).toBeInTheDocument();
  });
});

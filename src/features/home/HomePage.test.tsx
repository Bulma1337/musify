import { screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("renders a greeting, quick access and shelves with albums", async () => {
    renderPage(<HomePage />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/good|guten/i);
    expect((await screen.findAllByText("Morning Static")).length).toBeGreaterThan(1);
    expect(screen.getByText("Recently played")).toBeInTheDocument();
    expect(screen.getByText("New on your server")).toBeInTheDocument();
    expect(screen.getAllByText("Road Trip").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Quick access" })).toBeInTheDocument();
  });
});

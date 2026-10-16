import { screen } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { parseHex } from "./accentColor";
import { LikedPage } from "./LikedPage";

describe("LikedPage", () => {
  it("lists the starred tracks under the Favorites title", async () => {
    renderPage(<LikedPage />, { path: "/liked", url: "/liked" });
    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();
    expect(await screen.findByText("Song 4")).toBeInTheDocument();
    expect(screen.getByText("Song 8")).toBeInTheDocument();
    expect(screen.queryByText("Song 1")).not.toBeInTheDocument();
    expect(screen.getByText("2 tracks")).toBeInTheDocument();
  });
});

describe("parseHex", () => {
  it("reads 6- and 3-digit hex and rejects other values", () => {
    expect(parseHex(" #8b5cf6")).toEqual({ r: 139, g: 92, b: 246 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("color-mix(red)")).toBeNull();
  });
});

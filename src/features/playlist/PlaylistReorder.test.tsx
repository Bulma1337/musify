import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage } from "@/test/renderPage";
import { PlaylistPage } from "./PlaylistPage";

/** Minimal DataTransfer for jsdom (it has none). */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "move",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    setDragImage: () => {},
  };
}

/** The draggable row wrapper of a track title. */
const rowOf = (title: string) => screen.getByText(title).closest("[draggable]") as HTMLElement;

describe("playlist drag-and-drop reorder", () => {
  it("moves a track and sends the new order to the server", async () => {
    const { provider } = renderPage(<PlaylistPage />, { path: "/playlist/:id", url: "/playlist/pl1" });
    await screen.findByText("Song 1");
    // Road Trip = Song 1, Song 5, Song 7, Song 9 → drag Song 1 onto the upper half of Song 7 (jsdom
    // delivers no pointer coordinates for drag events, which counts as "above").

    const transfer = dataTransfer();
    fireEvent.dragStart(rowOf("Song 1"), { dataTransfer: transfer });
    fireEvent.dragOver(rowOf("Song 7"), { dataTransfer: transfer });
    fireEvent.drop(rowOf("Song 7"), { dataTransfer: transfer });

    await waitFor(() => expect(provider.calls.some((c) => c.method === "reorderPlaylist")).toBe(true));
    const call = provider.calls.find((c) => c.method === "reorderPlaylist")!;
    expect(call.args).toEqual(["pl1", ["t5", "t1", "t7", "t9"]]);
  });
});

import { screen } from "@testing-library/react";
import { usePlayer } from "@/player/store";
import { fakeTracks } from "@/test/fakeProvider";
import { renderPage } from "@/test/renderPage";
import { QueueView } from "./QueuePanel";

describe("QueueView", () => {
  it("renders the current track and what follows without re-rendering forever", async () => {
    renderPage(<QueueView />);
    usePlayer
      .getState()
      .playTracks(fakeTracks.slice(0, 3), 0, { type: "album", id: "al1", name: "Morning Static" });
    expect(await screen.findByText(fakeTracks[0]!.title)).toBeInTheDocument();
    expect(screen.getByText(fakeTracks[1]!.title)).toBeInTheDocument();
    expect(screen.getByText(fakeTracks[2]!.title)).toBeInTheDocument();
  });
});

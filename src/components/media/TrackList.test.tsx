import { fireEvent, screen } from "@testing-library/react";
import { fakeTracks } from "@/test/fakeProvider";
import { renderPage } from "@/test/renderPage";
import { usePlayer } from "@/player/store";
import { TrackList } from "./TrackList";

describe("TrackList", () => {
  it("renders rows and plays a track on double-click", async () => {
    const onPlay = vi.fn();
    renderPage(<TrackList tracks={fakeTracks} onPlay={onPlay} />);
    const row = await screen.findByText("Song 3");
    fireEvent.doubleClick(row);
    expect(onPlay).toHaveBeenCalledWith(2);
  });

  it("shows disc separators when tracks span several discs", async () => {
    const album = fakeTracks.filter((t) => t.album?.id === "al2");
    renderPage(<TrackList tracks={album} onPlay={() => {}} showDiscs useTrackNumbers />);
    expect(await screen.findByText(/^(CD|Disc) 2$/)).toBeInTheDocument();
  });

  it("highlights the current track", async () => {
    renderPage(<TrackList tracks={fakeTracks} onPlay={() => {}} />);
    usePlayer.setState({ current: { key: "x", track: fakeTracks[0]!, manual: false } });
    const title = await screen.findByText("Song 1");
    expect(title.className).toContain("text-accent");
  });
});

import { act, fireEvent, screen } from "@testing-library/react";
import type { Lyrics } from "@/api/provider";
import { fakeTracks } from "@/test/fakeProvider";
import { setupMockServer } from "@/test/msw";
import { renderPage } from "@/test/renderPage";
import { usePlayer } from "@/player/store";
import { LyricsPage } from "./LyricsPage";
import { LyricsPreviewCard } from "./LyricsPreviewCard";
import { previewLines, setLyricsOffset } from "./timing";

setupMockServer();
const track = fakeTracks[0]!;

const synced: Lyrics = {
  synced: true,
  lines: [
    { startMs: 1000, text: "First line" },
    { startMs: 5000, text: "Second line" },
    { startMs: 9000, text: "Third line" },
    { startMs: 13_000, text: "Fourth line" },
  ],
  offsetMs: 0,
  source: "server",
};
const plain: Lyrics = {
  synced: false,
  lines: [{ text: "Plain one" }, { text: "" }, { text: "Plain two" }],
  offsetMs: 0,
  source: "server",
};

function play(positionMs = 0) {
  act(() => {
    usePlayer.setState({
      current: { key: "q1", track, manual: false },
      isPlaying: false,
      positionMs,
      durationMs: track.durationMs,
    });
  });
}

afterEach(() => {
  localStorage.clear();
  usePlayer.setState({ current: null, positionMs: 0 });
});

describe("LyricsPage", () => {
  it("shows an empty state while nothing is playing", () => {
    renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    expect(screen.getByText(/Play a song/)).toBeInTheDocument();
  });

  it("renders the lines with title, source credit and offset controls", async () => {
    const { provider } = renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    provider.getLyrics = async () => synced;
    play();
    expect(await screen.findByRole("button", { name: "Second line" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /line$/ })).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Song 1" })).toBeInTheDocument();
    expect(screen.getByText("Lyrics: Server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show lyrics 0.1 s later" })).toBeInTheDocument();
  });

  it("marks the active line and seeks to a clicked line", async () => {
    const { provider } = renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    provider.getLyrics = async () => synced;
    play(5500);
    const second = await screen.findByRole("button", { name: "Second line" });
    expect(second).toHaveAttribute("aria-current", "true");

    const before = usePlayer.getState().seekNonce;
    fireEvent.click(screen.getByRole("button", { name: "Third line" }));
    expect(usePlayer.getState().positionMs).toBe(9000);
    expect(usePlayer.getState().seekNonce).toBe(before + 1);
    expect(await screen.findByRole("button", { name: "Third line" })).toHaveAttribute("aria-current", "true");
  });

  it("accounts for the lyrics offset and the per-track user offset when seeking", async () => {
    const { provider } = renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    provider.getLyrics = async () => ({ ...synced, offsetMs: -500 });
    setLyricsOffset(track.id, 300);
    play();
    fireEvent.click(await screen.findByRole("button", { name: "Second line" }));
    expect(usePlayer.getState().positionMs).toBe(5000 - 500 + 300);
  });

  it("changes and persists the offset with the − / + / reset buttons", async () => {
    const { provider } = renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    provider.getLyrics = async () => synced;
    play();
    await screen.findByRole("button", { name: "Second line" });
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics 0.1 s later" }));
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics 0.1 s later" }));
    expect(localStorage.getItem(`musify.lyrics.offset.${track.id}`)).toBe("200");
    expect(screen.getByText("+0.2 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics 0.1 s earlier" }));
    expect(screen.getByText("+0.1 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset timing" }));
    expect(localStorage.getItem(`musify.lyrics.offset.${track.id}`)).toBeNull();
  });

  it("shows unsynced lyrics as static text with a hint", async () => {
    const { provider } = renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    provider.getLyrics = async () => plain;
    play();
    expect(await screen.findByText("Plain one")).toBeInTheDocument();
    expect(screen.getByText("Plain two")).toBeInTheDocument();
    expect(screen.getByText(/no timing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plain one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Timing" })).not.toBeInTheDocument();
  });

  it("shows a friendly message when there are no lyrics", async () => {
    renderPage(<LyricsPage />, { path: "/lyrics", url: "/lyrics" });
    play();
    expect(await screen.findByText("No lyrics found for this song.")).toBeInTheDocument();
  });
});

describe("LyricsPreviewCard", () => {
  it("is hidden when the track has no lyrics", async () => {
    const { container, queryClient } = renderPage(<LyricsPreviewCard />);
    play();
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(["srv1", "lyrics", track.id, true])).toBeDefined(),
    );
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByText("Lyrics")).not.toBeInTheDocument();
  });

  it("shows the current and the next two lines and links to the full view", async () => {
    const { provider } = renderPage(<LyricsPreviewCard />);
    provider.getLyrics = async () => synced;
    play(5500);
    expect(await screen.findByText("Second line")).toBeInTheDocument();
    expect(screen.getByText("Third line")).toBeInTheDocument();
    expect(screen.getByText("Fourth line")).toBeInTheDocument();
    expect(screen.queryByText("First line")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open lyrics" })).toHaveAttribute("href", "/lyrics");
  });

  it("starts with the first lines of unsynced lyrics", async () => {
    const { provider } = renderPage(<LyricsPreviewCard />);
    provider.getLyrics = async () => plain;
    play();
    expect(await screen.findByText("Plain one")).toBeInTheDocument();
    expect(screen.getByText("Plain two")).toBeInTheDocument();
  });
});

describe("previewLines", () => {
  it("skips blank lines and starts at the first line before the song begins", () => {
    const withSpacer: Lyrics = {
      ...synced,
      lines: [synced.lines[0]!, { startMs: 3000, text: "" }, ...synced.lines.slice(1)],
    };
    expect(previewLines(withSpacer, 0).map((l) => l.line.text)).toEqual([
      "First line",
      "Second line",
      "Third line",
    ]);
    expect(previewLines(withSpacer, 3500).map((l) => [l.line.text, l.active])).toEqual([
      ["Second line", false],
      ["Third line", false],
      ["Fourth line", false],
    ]);
  });
});

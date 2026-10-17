import { screen } from "@testing-library/react";
import type { Lyrics, Track } from "@/api/provider";
import { useProvider } from "@/api/session";
import { createFakeProvider, fakeTracks } from "@/test/fakeProvider";
import { setupMockServer } from "@/test/msw";
import { renderPage } from "@/test/renderPage";
import { resolveLyrics, useLyrics } from "./useLyrics";

const mock = setupMockServer();
const track: Track = { ...fakeTracks[0]!, durationMs: 181_000 };

const serverSynced: Lyrics = {
  synced: true,
  lines: [{ startMs: 1000, text: "server synced" }],
  offsetMs: 0,
  source: "server",
};
const serverPlain: Lyrics = {
  synced: false,
  lines: [{ text: "server plain" }],
  offsetMs: 0,
  source: "server",
};

const lrclibRecord = (extra: Record<string, unknown> = {}) => ({
  duration: 181,
  instrumental: false,
  plainLyrics: "lrclib plain",
  syncedLyrics: "[00:01.00]lrclib synced",
  ...extra,
});

function providerWith(lyrics: Lyrics | null | Error) {
  const provider = createFakeProvider();
  provider.getLyrics = async () => {
    if (lyrics instanceof Error) throw lyrics;
    return lyrics;
  };
  return provider;
}

const firstText = (lyrics: Lyrics | null) => lyrics?.lines[0]?.text;

describe("resolveLyrics", () => {
  it("uses synced server lyrics without asking LRCLIB", async () => {
    mock.respond(() => lrclibRecord());
    const result = await resolveLyrics(providerWith(serverSynced), track);
    expect(firstText(result.lyrics)).toBe("server synced");
    expect(result.lyrics?.source).toBe("server");
    expect(mock.calls).toHaveLength(0);
  });

  it("prefers synced LRCLIB lyrics over unsynced server lyrics", async () => {
    mock.respond((call) => (call.endpoint === "get" ? lrclibRecord() : undefined));
    const result = await resolveLyrics(providerWith(serverPlain), track);
    expect(firstText(result.lyrics)).toBe("lrclib synced");
    expect(result.lyrics?.source).toBe("lrclib");
  });

  it("falls back to unsynced server lyrics when LRCLIB has no synced text", async () => {
    mock.respond((call) => (call.endpoint === "get" ? lrclibRecord({ syncedLyrics: null }) : undefined));
    const result = await resolveLyrics(providerWith(serverPlain), track);
    expect(firstText(result.lyrics)).toBe("server plain");
    expect(result.lyrics?.source).toBe("server");
  });

  it("uses unsynced LRCLIB text when the server has nothing", async () => {
    mock.respond((call) => (call.endpoint === "get" ? lrclibRecord({ syncedLyrics: null }) : undefined));
    const result = await resolveLyrics(providerWith(null), track);
    expect(firstText(result.lyrics)).toBe("lrclib plain");
    expect(result.lyrics?.synced).toBe(false);
    expect(result.lyrics?.source).toBe("lrclib");
  });

  it("survives a failing server and reports no lyrics", async () => {
    const result = await resolveLyrics(providerWith(new Error("down")), track);
    expect(result).toEqual({ lyrics: null, instrumental: false });
  });

  it("flags instrumental tracks", async () => {
    mock.respond(() => lrclibRecord({ instrumental: true, plainLyrics: null, syncedLyrics: null }));
    const result = await resolveLyrics(providerWith(null), track);
    expect(result).toEqual({ lyrics: null, instrumental: true });
  });
});

describe("useLyrics", () => {
  function Probe({ target }: { target: Track }) {
    const provider = useProvider();
    const { lyrics, source, isLoading } = useLyrics(target);
    return (
      <p>
        {isLoading ? "loading" : `${source ?? "none"}:${firstText(lyrics) ?? "-"}`} {provider.server.id}
      </p>
    );
  }

  it("caches per server and track, including negative results", async () => {
    const { queryClient } = renderPage(<Probe target={track} />);
    expect(await screen.findByText(/^none:-/)).toBeInTheDocument();
    const data = queryClient.getQueryData(["srv1", "lyrics", track.id, true]);
    expect(data).toEqual({ lyrics: null, instrumental: false });
    expect(queryClient.getQueryState(["srv1", "lyrics", track.id, true])?.isInvalidated).toBe(false);
  });

  it("exposes the source", async () => {
    mock.respond((call) => (call.endpoint === "get" ? lrclibRecord() : undefined));
    renderPage(<Probe target={track} />);
    expect(await screen.findByText(/^lrclib:lrclib synced/)).toBeInTheDocument();
  });
});

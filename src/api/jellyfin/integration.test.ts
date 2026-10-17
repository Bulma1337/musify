/// <reference types="node" />
/**
 * Integration test against the local Jellyfin dev server (devservers/, 127.0.0.1:8096).
 * Skipped automatically when the server is not reachable or its credentials are not available.
 *
 * `httpRequest` is replaced by node's `fetch` so the real adapter code talks to the real server.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { HttpOptions } from "@/api/http";
import type { LoginResult, MusicProvider, ServerProbe, Track } from "../provider";
import { jellyfinFactory } from ".";

vi.mock("@/api/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/http")>();
  return {
    ...actual,
    httpRequest: (url: string, options: HttpOptions = {}) =>
      fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body ?? undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      }),
  };
});

interface DevServer {
  url: string;
  username: string;
  password: string;
}

function readDevServer(): DevServer | null {
  const file = resolve(process.cwd(), "../../devservers/test-servers.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { jellyfin?: DevServer };
    if (parsed.jellyfin?.url && parsed.jellyfin.username) return parsed.jellyfin;
  }
  const {
    NAVIFY_JELLYFIN_URL: url,
    NAVIFY_JELLYFIN_USER: username,
    NAVIFY_JELLYFIN_PASSWORD: password,
  } = process.env;
  return url && username && password ? { url, username, password } : null;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/System/Info/Public`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const dev = readDevServer();
const available = dev !== null && (await reachable(dev.url));

describe.skipIf(!available)("Jellyfin dev server", () => {
  let found: ServerProbe;
  let session: LoginResult;
  let provider: MusicProvider;
  let albumTracks: Track[] = [];

  beforeAll(async () => {
    const server = dev!;
    const probe = await jellyfinFactory.probe(server.url);
    if (!probe) throw new Error("probe failed");
    found = probe;
    // Jellyfin invalidates earlier tokens of the same device id on every login, so log in only once.
    session = await jellyfinFactory.login(
      { url: server.url, username: server.username, password: server.password },
      found,
    );
    provider = await jellyfinFactory.connect(session.server, session.secret);
  });

  it("probes the server", () => {
    expect(found).toMatchObject({ kind: "jellyfin", serverType: "jellyfin" });
    expect(found.serverVersion).toMatch(/^\d+\.\d+/);
  });

  it("logs in with a token and user id, and rejects a wrong password", async () => {
    const server = dev!;
    expect(session.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(session.server.userId).toMatch(/^[0-9a-f]{32}$/);
    await expect(
      jellyfinFactory.login(
        { url: server.url, username: server.username, password: "definitely-wrong" },
        found,
      ),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("lists albums and opens one", async () => {
    const albums = await provider.getAlbumList("alphabeticalByName", { size: 50 });
    expect(albums.length).toBeGreaterThan(0);
    const names = albums.map((a) => a.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));

    const detail = await provider.getAlbum(albums[0]!.id);
    expect(detail.tracks.length).toBeGreaterThan(0);
    expect(detail.durationMs).toBeGreaterThan(0);
    const first = detail.tracks[0]!;
    expect(first).toMatchObject({ serverId: provider.server.id, album: { id: detail.id } });
    expect(first.durationMs).toBeGreaterThan(1000);
    expect(first.format.container).toBeTruthy();
    expect(first.format.sampleRate).toBeGreaterThan(0);
    albumTracks = (await Promise.all(albums.map((a) => provider.getAlbum(a.id)))).flatMap((a) => a.tracks);
    expect(albumTracks.length).toBeGreaterThanOrEqual(40);
  });

  it("runs the other album list types without errors", async () => {
    for (const type of [
      "recentlyPlayed",
      "recentlyAdded",
      "mostPlayed",
      "random",
      "starred",
      "highestRated",
    ] as const) {
      expect(Array.isArray(await provider.getAlbumList(type, { size: 5 })), type).toBe(true);
    }
    expect((await provider.getAlbumList("byGenre", { genre: "Jazz" })).length).toBeGreaterThan(0);
    expect((await provider.getAlbumList("byYear", { fromYear: 2018, toYear: 2018 })).length).toBeGreaterThan(
      0,
    );
  });

  it("browses artists, genres, search and tracks", async () => {
    const artists = await provider.getArtists();
    expect(artists.length).toBeGreaterThan(0);
    const artist = await provider.getArtist(artists[0]!.id);
    expect(artist.albums.length).toBeGreaterThan(0);
    expect(await provider.getArtistInfo(artists[0]!.id)).not.toBeUndefined();
    expect((await provider.getGenres()).length).toBeGreaterThan(0);
    expect((await provider.search("a", { artists: 5, albums: 5, tracks: 5 })).tracks.length).toBeGreaterThan(
      0,
    );
    expect((await provider.getRandomTracks({ size: 5 })).length).toBe(5);
    expect(Array.isArray(await provider.getTopTracks({ id: artists[0]!.id, name: artists[0]!.name }))).toBe(
      true,
    );
    expect((await provider.getSimilarTracks(albumTracks[0]!.id, 5)).length).toBeGreaterThan(0);
    expect((await provider.getTrack(albumTracks[0]!.id)).id).toBe(albumTracks[0]!.id);
    await expect(provider.getAlbum("00000000000000000000000000000000")).rejects.toMatchObject({
      name: "ProviderError",
    });
  });

  it("returns lyrics for a track that has them and null for the others", async () => {
    let withLyrics: { lyrics: NonNullable<Awaited<ReturnType<MusicProvider["getLyrics"]>>> } | undefined;
    let withoutLyrics = 0;
    for (const track of albumTracks) {
      const lyrics = await provider.getLyrics(track);
      if (!lyrics) {
        withoutLyrics++;
        continue;
      }
      withLyrics = { lyrics };
      break;
    }
    expect(withLyrics, "no track with lyrics on the dev server").toBeDefined();
    expect(withoutLyrics).toBeGreaterThan(0);
    const { lyrics } = withLyrics!;
    expect(lyrics.lines.length).toBeGreaterThan(1);
    expect(lyrics.synced).toBe(true);
    const times = lyrics.lines.map((l) => l.startMs);
    expect(times.every((t) => typeof t === "number")).toBe(true);
    expect(times).toEqual([...times].sort((x, y) => x! - y!));
  });

  it("streams the original file with header authentication", async () => {
    const track = albumTracks.find((t) => t.format.container === "flac") ?? albumTracks[0]!;
    const source = provider.getStreamSource(track);
    expect(source.url).not.toMatch(/api_key|token/i);
    const response = await fetch(source.url, { headers: { ...source.headers, Range: "bytes=0-1023" } });
    expect([200, 206]).toContain(response.status);
    expect(response.headers.get("content-type")).toMatch(/^audio\//);
    const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, 1024);
    expect(bytes.length).toBeGreaterThan(0);
    if (track.format.container === "flac") expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("fLaC");

    const download = provider.getDownloadSource(track);
    const downloaded = await fetch(download.url, { headers: { ...download.headers, Range: "bytes=0-15" } });
    expect([200, 206]).toContain(downloaded.status);
    await downloaded.body?.cancel();
  });

  it("transcodes on request, including from an offset", async () => {
    const track = albumTracks.find((t) => t.format.container === "flac") ?? albumTracks[0]!;
    for (const format of ["mp3", "opus"]) {
      const source = provider.getStreamSource(track, { maxBitRateKbps: 128, format });
      expect(source.transcoded).toBe(true);
      const response = await fetch(source.url, { headers: source.headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^audio\//);
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      expect(chunk.value?.length ?? 0).toBeGreaterThan(0);
      await reader.cancel();
    }
    const source = provider.getStreamSource(track, { maxBitRateKbps: 128, format: "mp3" });
    const seeked = new URL(source.url);
    seeked.searchParams.set(source.timeOffset!.param, String(30 * 10_000_000));
    const response = await fetch(seeked, { headers: source.headers });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("serves covers without authentication headers", async () => {
    const cover = albumTracks.find((t) => t.cover)?.cover;
    expect(cover).toBeDefined();
    const response = await fetch(provider.coverUrl(cover!, 128));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^image\//);
    await response.body?.cancel();
  });

  it("creates, reorders and deletes a playlist", async () => {
    const picks = albumTracks.slice(0, 5);
    const playlist = await provider.createPlaylist(
      `navify-it-${Date.now()}`,
      picks.map((t) => t.id),
    );
    try {
      const created = await provider.getPlaylist(playlist.id);
      expect(created.tracks.map((t) => t.id)).toEqual(picks.map((t) => t.id));
      expect(created.tracks.every((t) => t.playlistEntryId)).toBe(true);

      const reversed = [...created.tracks].reverse();
      await provider.reorderPlaylist(playlist.id, reversed);
      const after = await provider.getPlaylist(playlist.id);
      expect(after.tracks.map((t) => t.id)).toEqual(reversed.map((t) => t.id));

      await provider.removeFromPlaylist(playlist.id, [0]);
      expect((await provider.getPlaylist(playlist.id)).tracks).toHaveLength(4);
      await provider.addToPlaylist(playlist.id, [picks[0]!.id]);
      expect((await provider.getPlaylist(playlist.id)).tracks).toHaveLength(5);

      await provider.updatePlaylist(playlist.id, { name: "navify-it-renamed", public: true });
      expect(await provider.getPlaylist(playlist.id)).toMatchObject({
        name: "navify-it-renamed",
        public: true,
      });
      expect((await provider.getPlaylists()).some((p) => p.id === playlist.id)).toBe(true);
    } finally {
      await provider.deletePlaylist(playlist.id);
    }
    expect((await provider.getPlaylists()).some((p) => p.id === playlist.id)).toBe(false);
  });
});

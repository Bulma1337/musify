import { subsonicFailed, subsonicOk, setupMockServer } from "@/test/msw";
import { ProviderError, type ServerConfig } from "../provider";
import { makeToken, unwrapEnvelope } from "./client";
import { subsonicFactory } from ".";

const mock = setupMockServer();
const URL_BASE = "https://music.test";

describe("makeToken", () => {
  it("matches the vector from the Subsonic API docs", () => {
    expect(makeToken("sesame", "c19b2d")).toBe("26719a1196d2a940705a59634eb18eab");
  });
});

describe("unwrapEnvelope error mapping", () => {
  const kindOf = (code: number) => {
    try {
      unwrapEnvelope(subsonicFailed(code));
    } catch (e) {
      return (e as ProviderError).kind;
    }
    return null;
  };

  it("maps codes to kinds", () => {
    for (const code of [40, 41, 42, 43, 44, 50]) expect(kindOf(code)).toBe("auth");
    expect(kindOf(70)).toBe("notFound");
    for (const code of [0, 10, 20, 30, 60]) expect(kindOf(code)).toBe("server");
  });

  it("rejects non-envelopes", () => {
    expect(() => unwrapEnvelope({ foo: 1 })).toThrow(ProviderError);
  });
});

describe("probe", () => {
  it("recognizes a Subsonic server without sending credentials", async () => {
    mock.respond(() => subsonicFailed(10, "Missing parameter"));
    const result = await subsonicFactory.probe(`${URL_BASE}/`);
    expect(result).toEqual({ kind: "subsonic", url: URL_BASE });
    const call = mock.calls[0]!;
    expect(call.url.pathname).toBe("/rest/ping");
    for (const key of ["u", "t", "s", "p", "apiKey"]) expect(call.params.has(key)).toBe(false);
  });

  it("reports server type and version when the server tells", async () => {
    mock.respond(() => subsonicOk());
    expect(await subsonicFactory.probe(URL_BASE)).toEqual({
      kind: "subsonic",
      url: URL_BASE,
      serverType: "navidrome",
      serverVersion: "0.55.0",
    });
  });

  it("returns null for 404, non-JSON and foreign JSON", async () => {
    mock.respond(() => undefined);
    expect(await subsonicFactory.probe(URL_BASE)).toBeNull();
    mock.respond(() => new Response("<html></html>", { status: 200 }));
    expect(await subsonicFactory.probe(URL_BASE)).toBeNull();
    mock.respond(() => ({ hello: "world" }));
    expect(await subsonicFactory.probe(URL_BASE)).toBeNull();
  });
});

describe("login", () => {
  const found = {
    kind: "subsonic" as const,
    url: URL_BASE,
    serverType: "navidrome",
    serverVersion: "0.55.0",
  };

  it("succeeds with token auth", async () => {
    mock.respond(() => subsonicOk());
    const result = await subsonicFactory.login({ url: URL_BASE, username: "bob", password: "sesame" }, found);
    expect(result.secret).toBe("sesame");
    expect(result.server).toMatchObject({
      kind: "subsonic",
      name: "Navidrome (music.test)",
      url: URL_BASE,
      username: "bob",
      serverType: "navidrome",
      authMode: "token",
    });
    expect(result.server.id).toBeTruthy();
    const p = mock.calls[0]!.params;
    expect(p.get("u")).toBe("bob");
    expect(p.get("t")).toBe(makeToken("sesame", p.get("s")!));
    expect(p.get("v")).toBe("1.16.1");
    expect(p.get("c")).toBe("Musify");
    expect(p.get("f")).toBe("json");
  });

  it("maps a wrong password (code 40) to an auth error", async () => {
    mock.respond(() => subsonicFailed(40, "Wrong username or password"));
    await expect(
      subsonicFactory.login({ url: URL_BASE, username: "bob", password: "x" }, found),
    ).rejects.toMatchObject({
      kind: "auth",
      code: 40,
    });
  });

  it("falls back to legacy password auth on error 41", async () => {
    mock.respond((call) =>
      call.params.has("t") ? subsonicFailed(41, "token auth not supported") : subsonicOk(),
    );
    const result = await subsonicFactory.login({ url: URL_BASE, username: "bob", password: "pä" }, found);
    expect(result.server.authMode).toBe("password");
    const last = mock.calls[1]!.params;
    expect(last.get("p")).toBe("enc:70c3a4");
    expect(last.has("t")).toBe(false);
  });

  it("treats an empty username as an API key", async () => {
    mock.respond(() => subsonicOk());
    const result = await subsonicFactory.login(
      { url: URL_BASE, username: "", password: "KEY", name: "Mine" },
      found,
    );
    expect(result.server).toMatchObject({ authMode: "apiKey", username: "", name: "Mine" });
    const p = mock.calls[0]!.params;
    expect(p.get("apiKey")).toBe("KEY");
    expect(p.has("u")).toBe(false);
  });
});

describe("connect", () => {
  const server: ServerConfig = {
    id: "srv1",
    kind: "subsonic",
    name: "x",
    url: URL_BASE,
    username: "bob",
    authMode: "token",
    addedAt: "2025-01-01T00:00:00Z",
  };

  it("derives capabilities from OpenSubsonic extensions", async () => {
    mock.respond((call) =>
      call.endpoint === "getOpenSubsonicExtensions"
        ? subsonicOk({
            openSubsonicExtensions: [
              { name: "songLyrics", versions: [1, 2] },
              { name: "transcodeOffset", versions: [1] },
            ],
          })
        : subsonicOk(),
    );
    const provider = await subsonicFactory.connect(server, "pw");
    expect(provider.capabilities).toMatchObject({
      lyrics: true,
      syncedLyrics: true,
      wordSyncedLyrics: true,
      transcodeOffset: true,
      playlistReorder: "replace",
      playQueueSync: true,
    });
  });

  it("falls back for legacy servers", async () => {
    mock.respond(() => subsonicOk({}, { openSubsonic: false, type: "airsonic" }));
    const provider = await subsonicFactory.connect(server, "pw");
    expect(provider.capabilities).toMatchObject({
      syncedLyrics: false,
      wordSyncedLyrics: false,
      transcodeOffset: false,
      playlistReorder: "removeAdd",
    });
    expect(mock.calls.map((c) => c.endpoint)).toEqual(["ping"]);
  });
});

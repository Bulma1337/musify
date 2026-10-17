import { HttpResponse } from "msw";
import { providerFactories, factoryFor } from "../registry";
import { ProviderError, type ServerConfig } from "../provider";
import { authorizationHeader, getDeviceId, resetDeviceIdCache } from "./client";
import { jellyfinFactory } from ".";
import { publicInfo, setupJellyfinMock, status, testServer } from "./testing";

const mock = setupJellyfinMock();
const BASE = "https://jf.test";

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdCache();
});

const HEADER_WITHOUT_TOKEN =
  /^MediaBrowser Client="Navify", Device="Navify Desktop", DeviceId="[0-9a-f]{32}", Version="0\.1\.0"$/;

describe("authorizationHeader", () => {
  it("quotes every value and appends the token last", () => {
    expect(authorizationHeader("dev1")).toBe(
      'MediaBrowser Client="Navify", Device="Navify Desktop", DeviceId="dev1", Version="0.1.0"',
    );
    expect(authorizationHeader("dev1", "tok")).toBe(
      'MediaBrowser Client="Navify", Device="Navify Desktop", DeviceId="dev1", Version="0.1.0", Token="tok"',
    );
  });

  it("strips characters that would break the header", () => {
    expect(authorizationHeader('d"1', 'to"k')).toContain('DeviceId="d1", Version="0.1.0", Token="tok"');
  });
});

describe("device id", () => {
  it("is random, persisted and stable", async () => {
    const first = await getDeviceId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(localStorage.getItem("navify.device.json.deviceId")!)).toBe(first);
    resetDeviceIdCache();
    expect(await getDeviceId()).toBe(first);
  });
});

describe("probe", () => {
  it("recognizes Jellyfin without sending credentials", async () => {
    mock.respond(() => publicInfo);
    const result = await jellyfinFactory.probe(`${BASE}/`);
    expect(result).toEqual({ kind: "jellyfin", url: BASE, serverType: "jellyfin", serverVersion: "12.2.0" });
    expect(mock.calls[0]!.path).toBe("/System/Info/Public");
    expect(mock.calls[0]!.headers.has("authorization")).toBe(false);
  });

  it("accepts a server that only reports Id and Version", async () => {
    mock.respond(() => ({ Id: "x", Version: "10.8.0" }));
    expect(await jellyfinFactory.probe(BASE)).toMatchObject({ kind: "jellyfin", serverVersion: "10.8.0" });
  });

  it("returns null for 404, non-JSON and foreign JSON", async () => {
    mock.respond(() => undefined);
    expect(await jellyfinFactory.probe(BASE)).toBeNull();
    mock.respond(() => new Response("<html></html>", { status: 200 }));
    expect(await jellyfinFactory.probe(BASE)).toBeNull();
    mock.respond(() => ({ hello: "world" }));
    expect(await jellyfinFactory.probe(BASE)).toBeNull();
    mock.respond(() => ({ ProductName: "Something Else" }));
    expect(await jellyfinFactory.probe(BASE)).toBeNull();
    mock.respond(() => null);
    expect(await jellyfinFactory.probe(BASE)).toBeNull();
  });

  it("lets network errors propagate", async () => {
    mock.respond(() => HttpResponse.error());
    await expect(jellyfinFactory.probe(BASE)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("login", () => {
  const found = { kind: "jellyfin" as const, url: BASE, serverType: "jellyfin", serverVersion: "12.2.0" };

  it("returns the access token as secret and stores the user id", async () => {
    mock.respond(() => ({ AccessToken: "tok-123", User: { Id: "user-9", Name: "Bob" } }));
    const result = await jellyfinFactory.login({ url: BASE, username: " bob ", password: "pw" }, found);
    expect(result.secret).toBe("tok-123");
    expect(result.server).toMatchObject({
      kind: "jellyfin",
      name: "Jellyfin (jf.test)",
      url: BASE,
      username: "bob",
      userId: "user-9",
      serverType: "jellyfin",
      serverVersion: "12.2.0",
    });
    expect(result.server.id).toBeTruthy();

    const call = mock.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/Users/AuthenticateByName");
    expect(call.body).toEqual({ Username: "bob", Pw: "pw" });
    expect(call.headers.get("content-type")).toContain("application/json");
    expect(call.headers.get("authorization")).toMatch(HEADER_WITHOUT_TOKEN);
    expect(call.url.search).toBe("");
  });

  it("uses a custom name and the persisted device id", async () => {
    mock.respond(() => ({ AccessToken: "t", User: { Id: "u" } }));
    const result = await jellyfinFactory.login(
      { url: BASE, username: "bob", password: "pw", name: "Mine" },
      found,
    );
    expect(result.server.name).toBe("Mine");
    const deviceId = await getDeviceId();
    expect(mock.calls[0]!.headers.get("authorization")).toContain(`DeviceId="${deviceId}"`);
  });

  it("maps a wrong password (401) to an auth error", async () => {
    mock.respond(() => status(401));
    await expect(
      jellyfinFactory.login({ url: BASE, username: "bob", password: "x" }, found),
    ).rejects.toMatchObject({
      kind: "auth",
      code: 401,
    });
  });

  it("rejects a response without token", async () => {
    mock.respond(() => ({ User: { Id: "u" } }));
    await expect(
      jellyfinFactory.login({ url: BASE, username: "bob", password: "x" }, found),
    ).rejects.toMatchObject({
      kind: "invalidResponse",
    });
  });
});

describe("connect", () => {
  it("builds a provider with Jellyfin capabilities and authenticates with the token header", async () => {
    mock.respond(() => ({ Id: "user1" }));
    const provider = await jellyfinFactory.connect(testServer, "secret-token");
    expect(provider.capabilities).toEqual({
      lyrics: true,
      syncedLyrics: true,
      wordSyncedLyrics: true,
      similarTracks: true,
      artistInfo: true,
      topTracks: true,
      playQueueSync: false,
      transcodeOffset: true,
      playlistReorder: "move",
      publicPlaylists: true,
      ratings: false,
      transcoding: true,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.path).toBe("/Users/Me");
    expect(mock.calls[0]!.headers.get("authorization")).toMatch(/^MediaBrowser .*, Token="secret-token"$/);
    expect(mock.calls[0]!.url.search).toBe("");
  });

  it("resolves a missing user id through /Users/Me", async () => {
    mock.respond(() => ({ Id: "resolved" }));
    const { userId: _drop, ...withoutUser } = testServer;
    const provider = await jellyfinFactory.connect(withoutUser as ServerConfig, "t");
    expect(provider.server.userId).toBe("resolved");
  });

  it("fails with an auth error when the token is rejected", async () => {
    mock.respond(() => status(401));
    await expect(jellyfinFactory.connect(testServer, "stale")).rejects.toBeInstanceOf(ProviderError);
    await expect(jellyfinFactory.connect(testServer, "stale")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("registry", () => {
  it("registers Jellyfin after Subsonic", () => {
    expect(providerFactories.map((f) => f.kind)).toEqual(["subsonic", "jellyfin"]);
    expect(factoryFor("jellyfin")).toBe(jellyfinFactory);
  });
});

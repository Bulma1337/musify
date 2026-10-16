import { httpRequest } from "../http";
import {
  ProviderError,
  type Capabilities,
  type LoginInput,
  type LoginResult,
  type MusicProvider,
  type ProviderFactory,
  type ServerConfig,
  type ServerProbe,
} from "../provider";
import { JellyfinClient, getDeviceId, parseJson } from "./client";
import { JellyfinProvider } from "./provider";
import type { WireAuthResult, WireItem, WirePublicInfo } from "./wire";

export { JellyfinProvider } from "./provider";

/** Everything below is available in Jellyfin 12.x (lyric cues, playlist Move, InstantMix, …). */
const CAPABILITIES: Capabilities = {
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
};

function looksLikeJellyfin(info: WirePublicInfo | null): info is WirePublicInfo {
  if (!info || typeof info !== "object") return false;
  if (typeof info.ProductName === "string" && /jellyfin/i.test(info.ProductName)) return true;
  return Boolean(info.Id && info.Version);
}

async function probe(url: string): Promise<ServerProbe | null> {
  const base = url.replace(/\/+$/, "");
  let info: WirePublicInfo | null;
  try {
    const response = await httpRequest(`${base}/System/Info/Public`, { headers: { Accept: "application/json" } });
    // HTTP errors and non-JSON bodies just mean "not Jellyfin"; network and timeout errors propagate.
    if (!response.ok) return null;
    info = (await response.json()) as WirePublicInfo | null;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return null;
  }
  if (!looksLikeJellyfin(info)) return null;
  const result: ServerProbe = { kind: "jellyfin", url: base, serverType: "jellyfin" };
  if (info.Version) result.serverVersion = info.Version;
  return result;
}

async function login(input: LoginInput, found: ServerProbe): Promise<LoginResult> {
  const username = input.username.trim();
  const server: ServerConfig = {
    id: crypto.randomUUID(),
    kind: "jellyfin",
    name: input.name || `Jellyfin (${new URL(found.url).host})`,
    url: found.url,
    username,
    serverType: "jellyfin",
    serverVersion: found.serverVersion,
    addedAt: new Date().toISOString(),
  };

  const client = new JellyfinClient(server, undefined, await getDeviceId());
  const auth = await client.postJson<WireAuthResult>("/Users/AuthenticateByName", {
    Username: username,
    Pw: input.password,
  });
  const token = auth.AccessToken;
  const userId = auth.User?.Id;
  if (!token || !userId) throw new ProviderError("invalidResponse", "Jellyfin login returned no token");
  server.userId = userId;
  return { server, secret: token };
}

async function connect(server: ServerConfig, secret: string): Promise<MusicProvider> {
  const deviceId = await getDeviceId();
  let config = server;
  if (!config.userId) {
    // Configs created before the user id was stored: ask who the token belongs to.
    const me = await parseJson<WireItem>(
      await new JellyfinClient(server, secret, deviceId).request("GET", "/Users/Me"),
      "/Users/Me",
    );
    if (!me.Id) throw new ProviderError("invalidResponse", "Jellyfin returned no user id");
    config = { ...server, userId: me.Id };
  }
  const provider = new JellyfinProvider(new JellyfinClient(config, secret, deviceId), CAPABILITIES);
  await provider.ping();
  return provider;
}

export const jellyfinFactory: ProviderFactory = { kind: "jellyfin", probe, login, connect };

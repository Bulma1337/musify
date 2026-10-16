import { httpJson } from "../http";
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
import { API_VERSION, CLIENT_NAME, SubsonicClient, readEnvelope } from "./client";
import { SubsonicProvider } from "./provider";
import type { WireExtension } from "./wire";

export { SubsonicProvider } from "./provider";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function probe(url: string): Promise<ServerProbe | null> {
  const base = url.replace(/\/+$/, "");
  let json: unknown;
  try {
    json = await httpJson<unknown>(`${base}/rest/ping?v=${API_VERSION}&c=${CLIENT_NAME}&f=json`);
  } catch (error) {
    // Network and timeout problems are real failures; HTTP errors / non-JSON just mean "not Subsonic".
    if (error instanceof ProviderError && error.kind !== "network" && error.kind !== "timeout") return null;
    throw error;
  }
  const body = readEnvelope(json);
  if (!body) return null;
  const result: ServerProbe = { kind: "subsonic", url: base };
  if (body.type) result.serverType = body.type;
  if (body.serverVersion) result.serverVersion = body.serverVersion;
  return result;
}

async function login(input: LoginInput, found: ServerProbe): Promise<LoginResult> {
  const username = input.username.trim();
  const apiKey = username === "";
  const server: ServerConfig = {
    id: crypto.randomUUID(),
    kind: "subsonic",
    name: input.name || `${capitalize(found.serverType ?? "Subsonic")} (${new URL(found.url).host})`,
    url: found.url,
    username,
    serverType: found.serverType,
    serverVersion: found.serverVersion,
    authMode: apiKey ? "apiKey" : "token",
    addedAt: new Date().toISOString(),
  };

  try {
    await new SubsonicClient(server, input.password).call("ping");
  } catch (error) {
    // Error 41: the server does not support token auth; fall back to legacy `p=enc:`.
    if (!apiKey && error instanceof ProviderError && error.code === 41) {
      server.authMode = "password";
      await new SubsonicClient(server, input.password).call("ping");
    } else {
      throw error;
    }
  }
  return { server, secret: input.password };
}

async function connect(server: ServerConfig, secret: string): Promise<MusicProvider> {
  const client = new SubsonicClient(server, secret);
  const ping = await client.call("ping");

  let extensions: WireExtension[] = [];
  if (ping.openSubsonic) {
    try {
      extensions = (await client.call("getOpenSubsonicExtensions")).openSubsonicExtensions ?? [];
    } catch (error) {
      // Extensions are optional; auth problems would already have failed the ping.
      if (!(error instanceof ProviderError)) throw error;
    }
  }
  const find = (name: string) => extensions.find((e) => e.name === name);
  const songLyrics = find("songLyrics");
  const serverType = (ping.type ?? server.serverType ?? "").toLowerCase();

  const capabilities: Capabilities = {
    lyrics: true,
    syncedLyrics: songLyrics !== undefined,
    wordSyncedLyrics: songLyrics?.versions?.includes(2) ?? false,
    similarTracks: true,
    artistInfo: true,
    topTracks: true,
    playQueueSync: true,
    transcodeOffset: find("transcodeOffset") !== undefined,
    playlistReorder: serverType === "navidrome" ? "replace" : "removeAdd",
    publicPlaylists: true,
    ratings: true,
    transcoding: true,
  };
  return new SubsonicProvider(client, capabilities, find("formPost") !== undefined);
}

export const subsonicFactory: ProviderFactory = { kind: "subsonic", probe, login, connect };

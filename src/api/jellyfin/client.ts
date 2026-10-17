import { httpRequest, httpStatusError } from "../http";
import { ProviderError, type ServerConfig } from "../provider";
import { readPersisted, writePersisted } from "@/lib/persist";

export const CLIENT_NAME = "Musify";
export const DEVICE_NAME = "Musify Desktop";
export const APP_VERSION = "0.1.0";

type ParamValue = string | number | boolean | undefined;
/** Array values are sent comma-joined, the format Jellyfin expects for lists of ids/types/fields. */
export type Params = Record<string, ParamValue | readonly (string | number)[]>;

export function toSearchParams(params: Params): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.append(key, value.join(","));
    } else {
      search.append(key, String(value));
    }
  }
  return search;
}

// --- Device id -------------------------------------------------------------------------------------

let deviceIdPromise: Promise<string> | undefined;

function newDeviceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** One stable random id per installation, persisted so the server shows one device across restarts. */
export function getDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    try {
      const stored = await readPersisted<string>("device.json", "deviceId");
      if (stored) return stored;
    } catch {
      // Unreadable store: fall through and create a new id.
    }
    const id = newDeviceId();
    try {
      await writePersisted("device.json", "deviceId", id);
    } catch {
      // Not persisted; the id still stays stable for this session.
    }
    return id;
  })();
  return deviceIdPromise;
}

/** Test hook: forget the cached device id. */
export function resetDeviceIdCache(): void {
  deviceIdPromise = undefined;
}

// --- Authorization header --------------------------------------------------------------------------

const quote = (value: string): string => `"${value.replaceAll('"', "").replaceAll("\\", "")}"`;

/** `MediaBrowser Client="…", Device="…", DeviceId="…", Version="…"[, Token="…"]` */
export function authorizationHeader(deviceId: string, token?: string): string {
  const parts = [
    `Client=${quote(CLIENT_NAME)}`,
    `Device=${quote(DEVICE_NAME)}`,
    `DeviceId=${quote(deviceId)}`,
    `Version=${quote(APP_VERSION)}`,
  ];
  if (token) parts.push(`Token=${quote(token)}`);
  return `MediaBrowser ${parts.join(", ")}`;
}

// --- Client ----------------------------------------------------------------------------------------

interface RequestOptions {
  params?: Params;
  /** JSON request body. */
  json?: unknown;
  signal?: AbortSignal;
}

export class JellyfinClient {
  readonly base: string;

  constructor(
    readonly server: ServerConfig,
    private readonly token: string | undefined,
    readonly deviceId: string,
  ) {
    this.base = server.url.replace(/\/+$/, "");
  }

  /** Authenticated user id (needed for per-user data such as favorites and play counts). */
  get userId(): string {
    if (!this.server.userId) throw new ProviderError("auth", "Jellyfin user id is missing");
    return this.server.userId;
  }

  /** Request headers for the app's own calls AND for the audio engine / downloader. */
  get authHeaders(): Record<string, string> {
    return { Authorization: authorizationHeader(this.deviceId, this.token) };
  }

  /** Absolute URL without any credentials. */
  url(path: string, params: Params = {}): string {
    const query = toSearchParams(params).toString();
    return `${this.base}${path}${query ? `?${query}` : ""}`;
  }

  /** Performs the request; maps non-2xx statuses to `ProviderError`. */
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const url = this.url(path, options.params);
    const headers: Record<string, string> = { Accept: "application/json", ...this.authHeaders };
    if (options.json !== undefined) headers["Content-Type"] = "application/json";
    const response = await httpRequest(url, {
      method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      signal: options.signal,
      allowInsecureTls: this.server.allowInsecureTls,
    });
    if (!response.ok) throw httpStatusError(response.status, url);
    return response;
  }

  async getJson<T>(path: string, params?: Params): Promise<T> {
    return parseJson<T>(await this.request("GET", path, { params }), path);
  }

  async postJson<T>(path: string, json: unknown, params?: Params): Promise<T> {
    return parseJson<T>(await this.request("POST", path, { params, json }), path);
  }

  /** For endpoints that answer 204 No Content. */
  async send(method: "POST" | "DELETE", path: string, options: RequestOptions = {}): Promise<void> {
    await this.request(method, path, options);
  }
}

export async function parseJson<T>(response: Response, context: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderError("invalidResponse", `Invalid JSON from ${context}`, response.status, {
      cause: error,
    });
  }
}

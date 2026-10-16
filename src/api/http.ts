import { fetch as tauriFetch, type ClientOptions } from "@tauri-apps/plugin-http";
import { inTauri } from "@/lib/platform";
import { ProviderError } from "./provider";

export interface HttpOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Total request timeout. Default 20 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Accept self-signed / invalid TLS certificates (opt-in per server). */
  allowInsecureTls?: boolean;
}

/** App-wide network settings (Settings → Proxy). */
let clientDefaults: Pick<ClientOptions, "proxy"> = {};

export function setHttpProxy(proxyUrl: string | null): void {
  clientDefaults = proxyUrl ? { proxy: { all: proxyUrl } } : {};
}

/** Origins whose self-signed certificates the user explicitly accepted (per server setting). */
const insecureOrigins = new Set<string>();

export function setInsecureTls(serverUrl: string, allowed: boolean): void {
  const origin = new URL(serverUrl).origin;
  if (allowed) insecureOrigins.add(origin);
  else insecureOrigins.delete(origin);
}

function allowsInsecureTls(url: string): boolean {
  try {
    return insecureOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Performs an HTTP request to a music server.
 *
 * Inside Tauri the request runs through the Rust HTTP client (no CORS restrictions — Navidrome sends
 * no CORS headers). In the browser preview it goes through the Vite dev proxy at `/__proxy`.
 */
export async function httpRequest(url: string, options: HttpOptions = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    signal,
  };

  try {
    if (inTauri) {
      return await tauriFetch(url, {
        ...init,
        ...clientDefaults,
        connectTimeout: 10_000,
        ...(options.allowInsecureTls || allowsInsecureTls(url)
          ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true } }
          : {}),
      });
    }
    return await fetch(`/__proxy?url=${encodeURIComponent(url)}`, init);
  } catch (error) {
    if (timeout.aborted) throw new ProviderError("timeout", `Request timed out: ${redactUrl(url)}`);
    if (options.signal?.aborted) throw error;
    throw new ProviderError("network", `Network error: ${redactUrl(url)}`, undefined, { cause: error });
  }
}

/** Like `httpRequest` but parses JSON and maps HTTP errors to `ProviderError`. */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpRequest(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!response.ok) {
    throw httpStatusError(response.status, url);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderError("invalidResponse", `Invalid JSON from ${redactUrl(url)}`, response.status, {
      cause: error,
    });
  }
}

export function httpStatusError(status: number, url: string): ProviderError {
  const kind = status === 401 || status === 403 ? "auth" : status === 404 ? "notFound" : "server";
  return new ProviderError(kind, `HTTP ${status} from ${redactUrl(url)}`, status);
}

const SECRET_PARAMS = ["p", "t", "s", "apiKey", "api_key", "token", "ApiKey"];

/** Removes credentials from a URL so it can be logged or shown in errors. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of SECRET_PARAMS) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "***");
    }
    return parsed.toString();
  } catch {
    return "<invalid url>";
  }
}

/** Normalizes user input like "music.example.com/" to "https://music.example.com". */
export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

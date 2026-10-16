import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { md5 } from "@noble/hashes/legacy.js";
import { httpJson } from "../http";
import { ProviderError, type ServerConfig } from "../provider";
import type { WireBodies, WireEnvelope, WireEnvelopeBody } from "./wire";

export const API_VERSION = "1.16.1";
export const CLIENT_NAME = "Navify";

type ParamValue = string | number | boolean | undefined;
export type Params = Record<string, ParamValue | ParamValue[]>;

/** Envelope fields plus the endpoint-specific payload keys. */
export type SubsonicResponse = WireEnvelopeBody & WireBodies;

export function randomSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

/** Subsonic token: lowercase hex md5(password + salt). */
export function makeToken(password: string, salt: string): string {
  return bytesToHex(md5(utf8ToBytes(password + salt)));
}

export function toSearchParams(params: Params): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) if (v !== undefined) search.append(key, String(v));
  }
  return search;
}

/** Maps a Subsonic API error code onto a ProviderError. */
export function subsonicError(code: number, message: string | undefined): ProviderError {
  const text = message || `Subsonic error ${code}`;
  if ((code >= 40 && code <= 44) || code === 50) return new ProviderError("auth", text, code);
  if (code === 70) return new ProviderError("notFound", text, code);
  return new ProviderError("server", text, code);
}

/** Returns the `subsonic-response` body if `json` is a Subsonic envelope, else null. */
export function readEnvelope(json: unknown): SubsonicResponse | null {
  const body = (json as WireEnvelope | null)?.["subsonic-response"];
  if (!body || typeof body !== "object" || typeof body.status !== "string") return null;
  return body as SubsonicResponse;
}

/** Validates the envelope and throws a ProviderError for `status: "failed"`. */
export function unwrapEnvelope(json: unknown, context = "response"): SubsonicResponse {
  const body = readEnvelope(json);
  if (!body) throw new ProviderError("invalidResponse", `Not a Subsonic ${context}`);
  if (body.status === "failed") throw subsonicError(body.error?.code ?? 0, body.error?.message);
  return body;
}

export class SubsonicClient {
  readonly base: string;
  /** Set once the `formPost` extension is known; enables POST for very long id lists. */
  formPost = false;
  /** One salt/token for the lifetime of the instance, so media URLs are stable and cacheable. */
  private readonly stableSalt = randomSalt();

  constructor(
    readonly server: ServerConfig,
    private readonly secret: string,
  ) {
    this.base = `${server.url.replace(/\/+$/, "")}/rest`;
  }

  private authPairs(salt: string): [string, string][] {
    const mode = this.server.authMode ?? "token";
    if (mode === "apiKey") return [["apiKey", this.secret]];
    if (mode === "password") {
      return [
        ["u", this.server.username],
        ["p", `enc:${bytesToHex(utf8ToBytes(this.secret))}`],
      ];
    }
    return [
      ["u", this.server.username],
      ["t", makeToken(this.secret, salt)],
      ["s", salt],
    ];
  }

  private baseParams(salt: string): URLSearchParams {
    const search = new URLSearchParams();
    for (const [k, v] of this.authPairs(salt)) search.append(k, v);
    search.append("v", API_VERSION);
    search.append("c", CLIENT_NAME);
    return search;
  }

  /** Authenticated API call with a fresh salt. Resolves with the unwrapped response body. */
  async call(
    endpoint: string,
    params: Params = {},
    options: { post?: boolean } = {},
  ): Promise<SubsonicResponse> {
    const search = this.baseParams(randomSalt());
    search.append("f", "json");
    for (const [k, v] of toSearchParams(params)) search.append(k, v);
    const url = `${this.base}/${endpoint}`;
    const json = options.post
      ? await httpJson<unknown>(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: search.toString(),
          allowInsecureTls: this.server.allowInsecureTls,
        })
      : await httpJson<unknown>(`${url}?${search.toString()}`, {
          allowInsecureTls: this.server.allowInsecureTls,
        });
    return unwrapEnvelope(json, endpoint);
  }

  /** URL for <img> / the audio engine, using the instance's stable credentials. */
  mediaUrl(endpoint: string, params: Params): string {
    const search = toSearchParams(params);
    for (const [k, v] of this.baseParams(this.stableSalt)) search.append(k, v);
    return `${this.base}/${endpoint}?${search.toString()}`;
  }
}

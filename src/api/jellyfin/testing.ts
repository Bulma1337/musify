/**
 * MSW helper for the Jellyfin adapter tests (the shared `@/test/msw` helper does not record request
 * headers or JSON bodies, which Jellyfin's auth header and POST payloads need).
 *
 * In tests `inTauri` is false, so `httpRequest` calls `fetch("/__proxy?url=<encoded real url>")`; the
 * handler decodes the real URL and hands a `JellyfinCall` to a per-test responder. The responder returns a
 * JSON-serializable value, a `Response`, or `undefined` (→ HTTP 404).
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ServerConfig } from "../provider";

export interface JellyfinCall {
  /** The real (decoded) server URL the app tried to reach. */
  url: URL;
  method: string;
  /** URL path, e.g. "/Items/abc/Images/Primary". */
  path: string;
  params: URLSearchParams;
  headers: Headers;
  /** Parsed JSON request body (undefined when there is none). */
  body: unknown;
}

export type JellyfinResponder = (call: JellyfinCall) => unknown;

export const noContent = (): Response => new Response(null, { status: 204 });
export const status = (code: number): Response => new Response("error", { status: code });

export function setupJellyfinMock() {
  const calls: JellyfinCall[] = [];
  let responder: JellyfinResponder = () => undefined;

  const server = setupServer(
    http.all("*/__proxy", async ({ request }) => {
      const url = new URL(new URL(request.url).searchParams.get("url") ?? "");
      const text = request.method === "GET" ? "" : await request.text();
      const call: JellyfinCall = {
        url,
        method: request.method,
        path: url.pathname,
        params: new URLSearchParams(url.searchParams),
        headers: request.headers,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
      calls.push(call);
      const result = responder(call);
      if (result instanceof Response) return result;
      if (result === undefined) return new HttpResponse("not found", { status: 404 });
      return HttpResponse.json(result as Record<string, unknown>);
    }),
  );

  beforeAll(() => server.listen());
  afterEach(() => {
    calls.length = 0;
    responder = () => undefined;
  });
  afterAll(() => server.close());

  return {
    calls,
    last: (): JellyfinCall => calls[calls.length - 1]!,
    respond(fn: JellyfinResponder) {
      responder = fn;
    },
  };
}

export const publicInfo = {
  ServerName: "Home",
  Version: "12.2.0",
  ProductName: "Jellyfin Server",
  Id: "srv-guid",
  StartupWizardCompleted: true,
};

export const testServer: ServerConfig = {
  id: "srv1",
  kind: "jellyfin",
  name: "Test",
  url: "https://jf.test",
  username: "bob",
  userId: "user1",
  serverType: "jellyfin",
  serverVersion: "12.2.0",
  addedAt: "2025-01-01T00:00:00Z",
};

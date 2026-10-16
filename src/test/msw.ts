/**
 * MSW helper for adapter tests.
 *
 * In tests `inTauri` is false, so `httpRequest` calls `fetch("/__proxy?url=<encoded real url>")`.
 * We intercept that path, decode the `url` parameter and hand a parsed `RecordedCall` (real server URL,
 * query/form params, method) to a per-test responder. The responder returns a JSON-serializable value,
 * a `Response`, or `undefined` (→ HTTP 404).
 *
 * Usage (at the top level of a test file):
 *   const mock = setupMockServer();
 *   mock.respond((call) => (call.endpoint === "ping" ? subsonicOk() : undefined));
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export interface RecordedCall {
  /** The real (decoded) server URL the app tried to reach. */
  url: URL;
  method: string;
  /** Last path segment, e.g. "ping" for ".../rest/ping". */
  endpoint: string;
  /** Query parameters merged with a form-encoded POST body. */
  params: URLSearchParams;
}

export type Responder = (call: RecordedCall) => unknown;

export function setupMockServer() {
  const calls: RecordedCall[] = [];
  let responder: Responder = () => undefined;

  const server = setupServer(
    http.all("*/__proxy", async ({ request }) => {
      const target = new URL(request.url).searchParams.get("url") ?? "";
      const url = new URL(target);
      const params = new URLSearchParams(url.searchParams);
      if (request.method === "POST") {
        for (const [k, v] of new URLSearchParams(await request.text())) params.append(k, v);
      }
      const call: RecordedCall = {
        url,
        method: request.method,
        endpoint: url.pathname.split("/").pop() ?? "",
        params,
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
    respond(fn: Responder) {
      responder = fn;
    },
  };
}

/** Successful Subsonic envelope; `body` is merged next to the status fields. */
export function subsonicOk(body: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      type: "navidrome",
      serverVersion: "0.55.0",
      openSubsonic: true,
      ...meta,
      ...body,
    },
  };
}

export function subsonicFailed(code: number, message = "failed") {
  return { "subsonic-response": { status: "failed", version: "1.16.1", error: { code, message } } };
}

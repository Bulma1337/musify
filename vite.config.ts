import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import type { IncomingMessage } from "node:http";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/** Hop-by-hop or encoding headers that must not be forwarded verbatim. */
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Dev-only proxy for the browser preview: `/__proxy?url=<server url>` forwards to the music server,
 * because servers like Navidrome send no CORS headers. Inside Tauri the Rust HTTP client is used instead.
 */
function devServerProxy(): Plugin {
  return {
    name: "navify-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__proxy", async (req, res) => {
        const target = new URL(req.url ?? "", "http://localhost").searchParams.get("url");
        if (!target || !/^https?:\/\//.test(target)) {
          res.statusCode = 400;
          res.end("missing or invalid url");
          return;
        }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (!SKIP_HEADERS.has(key) && typeof value === "string") headers.set(key, value);
          }
          const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: await readBody(req),
            redirect: "follow",
          });
          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            if (!SKIP_HEADERS.has(key)) res.setHeader(key, value);
          });
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
          res.statusCode = 502;
          res.end(`proxy error: ${(error as Error).message}`);
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devServerProxy()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Tauri-specific dev server settings
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    sourcemap: false,
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The persistent module cache does not notice new files matched by import.meta.glob (feature locales).
    fsModuleCache: false,
  },
});

// Full-resolution screenshots of the browser preview (`npm run dev`), logged in to the local test
// Navidrome from `devservers/test-servers.json`. Uses headless Microsoft Edge via the DevTools protocol.
//
// Usage: node scripts/screenshots.mjs [--size=1440x900] [--app=http://localhost:1420/] <route> [<route> …]
//   route: "/", "/album/<id>", "/search?q=x" — append "@js=<expression>" to run JS before the shot.
// Output: .dev/shots/<route>.png
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const sizeArg = args.find((a) => a.startsWith("--size="));
const [width, height] = (sizeArg?.slice(7) ?? "1440x900").split("x").map(Number);
const routes = args.filter((a) => !a.startsWith("--"));
const outDir = join(root, ".dev", "shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333;
const appArg = args.find((a) => a.startsWith("--app="));
const APP = appArg ? appArg.slice(6) : "http://localhost:1420/";
// A git worktree (.worktrees/<name>) has no devservers/ of its own: use the main checkout's.
const serversFile = [join(root, "devservers"), join(root, "..", "..", "devservers")]
  .map((dir) => join(dir, "test-servers.json"))
  .find((file) => existsSync(file));
const cfg = JSON.parse(readFileSync(serversFile, "utf8")).navidrome;
mkdirSync(outDir, { recursive: true });

const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(root, ".dev", "edge-profile")}`,
  "--no-first-run",
  "--disable-extensions",
  `--window-size=${width},${height}`,
  "about:blank",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = [];
for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
const send = (method, params = {}) =>
  new Promise((done) => {
    const id = ++nextId;
    pending.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = (expression) =>
  send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url: APP });
await sleep(1500);

// Dev session: server list in localStorage, secret in sessionStorage (browser-preview storage).
const server = {
  id: "dev-navidrome",
  kind: "subsonic",
  name: "Navidrome (lokal)",
  url: cfg.url,
  username: cfg.username,
  serverType: "navidrome",
  authMode: "token",
  addedAt: new Date().toISOString(),
};
await evaluate(`localStorage.setItem("musify.servers.json.servers", ${JSON.stringify(JSON.stringify([server]))});
  localStorage.setItem("musify.servers.json.activeServerId", ${JSON.stringify(JSON.stringify(server.id))});
  sessionStorage.setItem("musify.dev-secret.${server.id}", ${JSON.stringify(cfg.password)}); true`);
await send("Page.reload");
await sleep(3000);

for (const spec of routes.length ? routes : ["/"]) {
  const [route, js] = spec.split("@js=");
  await send("Page.navigate", { url: `${APP}#${route}` });
  await sleep(2500);
  if (js) {
    await evaluate(js);
    await sleep(1500);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const name = `${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}${js ? "_js" : ""}.png`;
  writeFileSync(join(outDir, name), Buffer.from(shot.result.data, "base64"));
  console.log(`saved .dev/shots/${name}`);
}
ws.close();
edge.kill();
process.exit(0);

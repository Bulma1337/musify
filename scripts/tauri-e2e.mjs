// Drives the real desktop app (started with scripts/dev-debug.ps1) over the WebView2 DevTools
// protocol: logs in to the local test Navidrome, plays an album with volume 0 through the native
// engine and checks position, seek, next and pause. Screenshots go to .dev/shots/tauri-*.png.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cfg = JSON.parse(readFileSync(join(root, "devservers", "test-servers.json"), "utf8")).navidrome;
const outDir = join(root, ".dev", "shots");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 300 && !page; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    page = targets.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  } catch {
    // app not up yet
  }
  if (!page) await sleep(1000);
}
if (!page) throw new Error("app window not found on port 9222");

const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails)
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 500));
  return res.result?.result?.value;
};
const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `tauri-${name}.png`), Buffer.from(res.result.data, "base64"));
};
const waitFor = async (expression, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(expression)) return true;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${expression}`);
};

await waitFor("!!window.__musify && window.__musify.useSession.getState().status !== 'loading'", 60_000);
const status = await evaluate("window.__musify.useSession.getState().status");
const report = { initialStatus: status };

if (status !== "ready") {
  await evaluate(`(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(document.querySelector('input[autocomplete="url"]'), ${JSON.stringify(cfg.url)});
    set(document.querySelector('input[autocomplete="username"]'), ${JSON.stringify(cfg.username)});
    set(document.querySelector('input[type="password"]'), ${JSON.stringify(cfg.password)});
    return true;
  })()`);
  await sleep(2500);
  await evaluate("document.querySelector('form').requestSubmit(), true");
  await waitFor("window.__musify.useSession.getState().status === 'ready'", 30_000);
}
report.loggedIn = true;

const player = "window.__musify.usePlayer.getState()";
const albumId = await evaluate(`(async () => {
  const p = window.__musify.useSession.getState().provider;
  const albums = await p.getAlbumList("alphabeticalByName", { size: 50 });
  const album = albums.find((a) => a.name === "Neon Circuits") ?? albums[0];
  return album.id;
})()`);
await evaluate(`location.hash = "#/album/${albumId}"; true`);
await sleep(2000);
await evaluate(`${player}.setVolume(0), true`);
await evaluate(`(async () => {
  const p = window.__musify.useSession.getState().provider;
  const album = await p.getAlbum(${JSON.stringify(albumId)});
  window.__musify.usePlayer.getState().playTracks(album.tracks, 0, { type: "album", id: album.id, name: album.name });
  return true;
})()`);

await waitFor(`${player}.positionMs > 1500`, 20_000);
report.firstTrack = await evaluate(`${player}.current.track.title`);
report.positionAfterStart = await evaluate(`${player}.positionMs`);
report.engine = await evaluate("JSON.parse(JSON.stringify(window.__musify.useEngineStatus.getState()))");
await shot("playing");

await evaluate(`${player}.seek(15000), true`);
await sleep(1500);
report.positionAfterSeek = await evaluate(`${player}.positionMs`);

await evaluate(`${player}.next(), true`);
await waitFor(
  `${player}.positionMs > 500 && ${player}.current.track.title !== ${JSON.stringify(report.firstTrack)}`,
  15_000,
);
report.secondTrack = await evaluate(`${player}.current.track.title`);

await evaluate(`${player}.setPlaying(false), true`);
await sleep(800);
const pausedAt = await evaluate(`${player}.positionMs`);
await sleep(1500);
report.pauseHolds = (await evaluate(`${player}.positionMs`)) === pausedAt;
report.isPlayingAfterPause = await evaluate(`${player}.isPlaying`);
await shot("paused");

console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);

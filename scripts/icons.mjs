// Regenerates the app icons in src-tauri/icons/ and the logos in public/ from the logo SVGs in
// src-tauri/icons/. All sizes show the same mark (the m and four grooves); small sizes come from
// versions with heavier strokes so the grooves stay visible in the tray, the taskbar and the title bar:
//   musify-logo-tiny.svg   16–24 px
//   musify-logo-small.svg  30–50 px (also the title bar and favicon)
//   musify-logo.svg        64 px and up
//
// Usage: node scripts/icons.mjs   (intermediate files go to .dev/icons/)
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const icons = join(root, "src-tauri", "icons");
const work = join(root, ".dev", "icons");
const SOURCES = {
  full: "musify-logo.svg",
  small: "musify-logo-small.svg",
  tiny: "musify-logo-tiny.svg",
};
/** Entries of icon.ico by source. Windows picks the closest size for each DPI. */
const ICO_SIZES = { tiny: [16, 20, 24], small: [32, 40, 48], full: [64, 256] };
/** Bundle files that are rendered from the heavier small mark instead of the full one. */
const SMALL_FILES = ["32x32.png", "Square30x30Logo.png", "Square44x44Logo.png", "StoreLogo.png"];

function tauriIcon(source, out, png) {
  const command = `npx tauri icon "${join(icons, SOURCES[source])}" -o "${out}"${png ? ` --png ${png.join(",")}` : ""}`;
  const result = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) throw new Error(`tauri icon failed for ${source}`);
}

/** An .ico file with one PNG entry per image (supported since Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// All default bundle icons from the full mark, the small ones again from the heavier small mark.
tauriIcon("full", join(work, "full"));
tauriIcon("small", join(work, "small"));
for (const file of [
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
]) {
  copyFileSync(join(work, "full", file), join(icons, file));
}
for (const file of SMALL_FILES) copyFileSync(join(work, "small", file), join(icons, file));

// icon.ico: every size from the mark that suits it.
const images = [];
for (const [source, sizes] of Object.entries(ICO_SIZES)) {
  const out = join(work, `ico-${source}`);
  tauriIcon(source, out, sizes);
  for (const size of sizes) images.push({ size, data: readFileSync(join(out, `${size}x${size}.png`)) });
}
images.sort((a, b) => a.size - b.size);
writeFileSync(join(icons, "icon.ico"), buildIco(images));

// The web frontend: the full logo (login, error page) and the small one (title bar, favicon).
copyFileSync(join(icons, SOURCES.full), join(root, "public", "musify.svg"));
copyFileSync(join(icons, SOURCES.small), join(root, "public", "musify-small.svg"));
console.log(`icons written to ${icons}`);

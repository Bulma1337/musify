// Translation helper.
//   node scripts/i18n.mjs export <out.json>   English base + feature texts merged into one file (what
//                                               translators get; the extra languages have this shape)
//   node scripts/i18n.mjs prune                drops keys from src/i18n/locales/extra/*.json that
//                                               English no longer has
// Missing or extra keys, placeholders and plural forms are checked by src/i18n/extraLocales.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const extraDir = path.join(src, "i18n", "locales", "extra");
const PLURAL = /_(zero|one|two|few|many|other)$/;

function englishTree() {
  const merged = JSON.parse(fs.readFileSync(path.join(src, "i18n/locales/en.json"), "utf8"));
  const features = path.join(src, "features");
  for (const feature of fs.readdirSync(features).sort()) {
    const file = path.join(features, feature, "locales", "en.json");
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      if (key in merged) throw new Error(`duplicate top-level key "${key}" in ${feature}`);
      merged[key] = value;
    }
  }
  return merged;
}

function baseKeys(tree, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(tree)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.add(p.replace(PLURAL, ""));
    else baseKeys(value, p, out);
  }
  return out;
}

const [command, arg] = process.argv.slice(2);
if (command === "export") {
  if (!arg) throw new Error("usage: export <out.json>");
  fs.writeFileSync(arg, JSON.stringify(englishTree(), null, 2) + "\n");
  console.log(`wrote ${arg}`);
} else if (command === "prune") {
  const wanted = baseKeys(englishTree());
  for (const file of fs.readdirSync(extraDir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(extraDir, file);
    const tree = JSON.parse(fs.readFileSync(full, "utf8"));
    let removed = 0;
    const prune = (node, prefix) => {
      for (const [key, value] of Object.entries(node)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") {
          if (!wanted.has(p.replace(PLURAL, ""))) {
            delete node[key];
            removed++;
          }
        } else {
          prune(value, p);
          if (Object.keys(value).length === 0) delete node[key];
        }
      }
    };
    prune(tree, "");
    fs.writeFileSync(full, JSON.stringify(tree, null, 2) + "\n");
    console.log(`${file}: removed ${removed}`);
  }
} else {
  console.log("usage: node scripts/i18n.mjs export <out.json> | prune");
  process.exitCode = 1;
}

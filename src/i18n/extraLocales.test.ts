import { collectMessages, LANGUAGES } from "./index";

const extra = import.meta.glob<Record<string, unknown>>("./locales/extra/*.json", {
  eager: true,
  import: "default",
});

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Dotted key → value, for every string in a message tree. */
function flatten(tree: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else if (value && typeof value === "object") {
      for (const [k, v] of flatten(value as Record<string, unknown>, path)) out.set(k, v);
    }
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Plural keys share one base ("trackCount_one" → "trackCount"). */
function grouped(flat: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of flat) {
    const base = key.replace(PLURAL, "");
    out.set(base, [...(out.get(base) ?? []), value]);
  }
  return out;
}

const english = flatten(collectMessages("en"));
const englishGroups = grouped(english);
const pluralBases = new Set(
  [...english.keys()].filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, "")),
);
const extraCodes = LANGUAGES.map((l) => l.code).filter((c) => c !== "de" && c !== "en");

describe("translations", () => {
  it("exist for every language in the list", () => {
    for (const code of extraCodes) expect(extra[`./locales/extra/${code}.json`], code).toBeDefined();
    expect(Object.keys(extra)).toHaveLength(extraCodes.length);
  });

  it.each(extraCodes)("%s has every text, with the same placeholders", (code) => {
    const messages = extra[`./locales/extra/${code}.json`];
    if (!messages) return;
    const flat = flatten(messages);
    const groups = grouped(flat);
    expect([...groups.keys()].sort()).toEqual([...englishGroups.keys()].sort());
    for (const [base, values] of groups) {
      const wanted = placeholders(englishGroups.get(base)!.at(-1)!);
      for (const value of values) {
        expect(value.trim(), `${code}: ${base}`).not.toBe("");
        // A plural form may leave out {{count}} ("one song"); every other placeholder stays.
        const got = placeholders(value);
        const expected = pluralBases.has(base) ? wanted.filter((p) => p !== "count") : wanted;
        for (const p of expected) expect(got, `${code}: ${base} needs {{${p}}}`).toContain(p);
        for (const p of got) expect(wanted, `${code}: ${base} has unknown {{${p}}}`).toContain(p);
      }
    }
  });

  it.each(extraCodes)("%s has the plural forms its language needs", (code) => {
    const messages = extra[`./locales/extra/${code}.json`];
    if (!messages) return;
    const flat = flatten(messages);
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const base of pluralBases) {
      for (const category of categories) {
        // "many" in French, Spanish, Italian and Portuguese is only for millions; "other" covers it.
        if (category === "many" && ["fr", "es", "it", "pt"].includes(code)) continue;
        expect(flat.has(`${base}_${category}`), `${code}: ${base}_${category}`).toBe(true);
      }
    }
  });
});

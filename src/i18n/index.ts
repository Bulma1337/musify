import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";

/** The UI languages, each named in itself. German and English are the source languages. */
export const LANGUAGES = [
  { code: "de", name: "Deutsch" },
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "cs", name: "Čeština" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "nb", name: "Norsk bokmål" },
  { code: "fi", name: "Suomi" },
  { code: "hu", name: "Magyar" },
  { code: "ro", name: "Română" },
  { code: "el", name: "Ελληνικά" },
  { code: "uk", name: "Українська" },
  { code: "ru", name: "Русский" },
  { code: "tr", name: "Türkçe" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "hi", name: "हिन्दी" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "th", name: "ไทย" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];
export const supportedLanguages: readonly Language[] = LANGUAGES.map((l) => l.code);

type Messages = Record<string, unknown>;

/**
 * German and English: feature-local translations in `src/features/<feature>/locales/{de,en}.json`,
 * each with a single top-level key (the feature name), merged into the shared files here, so
 * features can be developed in parallel without editing one big file.
 */
const featureFiles = import.meta.glob<Messages>("../features/*/locales/*.json", {
  eager: true,
  import: "default",
});

/** All other languages: one translated file each (`locales/extra/<code>.json`), loaded when chosen. */
const extraFiles = import.meta.glob<Messages>("./locales/extra/*.json", { import: "default" });

export function collectMessages(language: "de" | "en"): Messages {
  const base: Messages = { ...(language === "de" ? de : en) };
  for (const [path, messages] of Object.entries(featureFiles)) {
    if (path.endsWith(`/${language}.json`)) Object.assign(base, messages);
  }
  return base;
}

/** Makes a language's texts available; English fills any gap. */
export async function loadLanguage(language: Language): Promise<void> {
  if (language === "de" || language === "en" || i18n.hasResourceBundle(language, "translation")) return;
  const load = extraFiles[`./locales/extra/${language}.json`];
  if (!load) return;
  i18n.addResourceBundle(language, "translation", await load(), true, true);
}

/** Loads a language and switches to it. */
export async function changeLanguage(language: Language): Promise<void> {
  await loadLanguage(language);
  await i18n.changeLanguage(language);
}

/** The supported language for a BCP 47 tag ("pt-BR" → "pt", "zh-HK" → "zh-TW"), or null. */
export function matchLanguage(tag: string): Language | null {
  const lower = tag.toLowerCase();
  const exact = supportedLanguages.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const [base, ...rest] = lower.split("-");
  if (base === "zh") return rest.some((p) => p === "tw" || p === "hk" || p === "mo" || p === "hant") ? "zh-TW" : "zh-CN";
  if (base === "no" || base === "nn") return "nb";
  return supportedLanguages.find((l) => l === base) ?? null;
}

export function detectLanguage(): Language {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return "en";
}

const initial = detectLanguage();

void i18n.use(initReactI18next).init({
  resources: { de: { translation: collectMessages("de") }, en: { translation: collectMessages("en") } },
  lng: initial === "de" ? "de" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// A system language other than German or English is loaded right after start.
if (initial !== "de" && initial !== "en") void changeLanguage(initial);

export default i18n;

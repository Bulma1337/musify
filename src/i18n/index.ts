import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";

export const supportedLanguages = ["de", "en"] as const;
export type Language = (typeof supportedLanguages)[number];

type Messages = Record<string, unknown>;

/**
 * Feature-local translations live in `src/features/<feature>/locales/{de,en}.json`, each with a single
 * top-level key (the feature name). They are merged into the shared resources here, so features can
 * be developed in parallel without editing one big file.
 */
const featureFiles = import.meta.glob<Messages>("../features/*/locales/*.json", {
  eager: true,
  import: "default",
});

export function collectMessages(language: Language): Messages {
  const base: Messages = { ...(language === "de" ? de : en) };
  for (const [path, messages] of Object.entries(featureFiles)) {
    if (path.endsWith(`/${language}.json`)) Object.assign(base, messages);
  }
  return base;
}

export function detectLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { de: { translation: collectMessages("de") }, en: { translation: collectMessages("en") } },
  lng: detectLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;

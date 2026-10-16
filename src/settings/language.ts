import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import i18n, { supportedLanguages, type Language } from "@/i18n";
import { readPersisted, writePersisted } from "@/lib/persist";

interface LanguageState {
  /** The language the user picked; null = follow the system language. */
  language: Language | null;
  setLanguage(language: Language): void;
}

/** Same persistence as the other settings (plugin-store in the app, localStorage in the preview). */
const storage: StateStorage = {
  getItem: async (name) => (await readPersisted<string>("settings.json", name)) ?? null,
  setItem: (name, value) => writePersisted("settings.json", name, value),
  removeItem: (name) => writePersisted("settings.json", name, null),
};

export const useLanguage = create<LanguageState>()(
  persist(
    (set) => ({
      language: null,
      setLanguage: (language) => {
        set({ language });
        void i18n.changeLanguage(language);
      },
    }),
    {
      name: "navify.language",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: ({ language }) => ({ language }),
      merge: (persisted, current) => {
        const saved = (persisted as { language?: unknown } | undefined)?.language;
        const valid = supportedLanguages.find((l) => l === saved);
        return { ...current, language: valid ?? null };
      },
    },
  ),
);

/** Applies the stored language at startup (and after settings were loaded). */
export function useLanguageController() {
  const language = useLanguage((s) => s.language);
  useEffect(() => {
    if (language && i18n.language !== language) void i18n.changeLanguage(language);
  }, [language]);
}

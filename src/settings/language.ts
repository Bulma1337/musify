import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import i18n, { changeLanguage, supportedLanguages, type Language } from "@/i18n";
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
        void changeLanguage(language);
      },
    }),
    {
      name: "musify.language",
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
    if (language && i18n.language !== language) void changeLanguage(language);
  }, [language]);
}

/**
 * Loads the stored language and applies it. Awaited in `main.tsx` before the first render, so the
 * onboarding and login screens already show the chosen language. A storage failure keeps the
 * system language instead of blocking startup.
 */
export async function applyStoredLanguage(): Promise<void> {
  try {
    await useLanguage.persist.rehydrate();
    const { language } = useLanguage.getState();
    if (language && i18n.language !== language) await changeLanguage(language);
  } catch {
    // Keep the detected system language.
  }
}

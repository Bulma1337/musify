import { useTranslation } from "react-i18next";
import { TitleBar } from "./layout/TitleBar";

/**
 * Application shell: title bar, library (left), main view, now-playing panel (right), player bar.
 * The panels are filled in milestone 2; this is the static frame.
 */
export function App() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1 gap-2 px-2">
        <aside className="w-[300px] shrink-0 rounded-lg bg-surface p-4">
          <h2 className="font-bold">{t("library.title")}</h2>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto rounded-lg bg-gradient-to-b from-accent-soft to-surface to-40% bg-surface p-6">
          <h1 className="text-5xl font-extrabold tracking-tight">{t("app.name")}</h1>
          <p className="mt-2 text-subdued">{t("app.tagline")}</p>
        </main>
        <aside className="hidden w-[320px] shrink-0 rounded-lg bg-surface p-4 xl:block">
          <p className="text-subdued">{t("nowPlaying.nothing")}</p>
        </aside>
      </div>
      <footer className="h-[72px] shrink-0" />
    </div>
  );
}

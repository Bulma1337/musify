import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Copy, House, Minus, Search, Square, X } from "lucide-react";
import { inTauri } from "@/lib/platform";

function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  if (!inTauri) return null;
  const win = getCurrentWindow();
  const button =
    "grid h-full w-12 place-items-center text-subdued transition-colors hover:bg-white/10 hover:text-text";

  return (
    <div className="flex h-full">
      <button
        type="button"
        className={button}
        aria-label={t("window.minimize")}
        onClick={() => void win.minimize()}
      >
        <Minus size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={button}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={13} strokeWidth={1.5} />}
      </button>
      <button
        type="button"
        className={`${button} hover:bg-[#e81123] hover:text-white`}
        aria-label={t("window.close")}
        onClick={() => void win.close()}
      >
        <X size={17} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** Frameless window title bar: navigation, home, search and window controls (Spotify-style). */
export function TitleBar() {
  const { t } = useTranslation();
  const round = "grid size-8 place-items-center rounded-full text-subdued hover:text-text";

  return (
    <header data-tauri-drag-region className="flex h-16 shrink-0 items-center gap-2 pl-3">
      <div data-tauri-drag-region className="flex flex-1 items-center gap-1">
        <img src="/navify.svg" alt="" className="mr-2 size-7" draggable={false} />
        <button type="button" className={round} aria-label={t("nav.back")} onClick={() => history.back()}>
          <ChevronLeft size={22} />
        </button>
        <button
          type="button"
          className={round}
          aria-label={t("nav.forward")}
          onClick={() => history.forward()}
        >
          <ChevronRight size={22} />
        </button>
      </div>

      <div className="flex w-full max-w-[480px] items-center gap-2">
        <button
          type="button"
          className="grid size-12 shrink-0 place-items-center rounded-full bg-elevated text-text transition-transform hover:scale-105"
          aria-label={t("nav.home")}
        >
          <House size={22} />
        </button>
        <label className="group flex h-12 flex-1 items-center gap-3 rounded-full bg-elevated px-4 ring-white/20 focus-within:ring-2 hover:bg-highlight">
          <Search size={22} className="shrink-0 text-subdued group-focus-within:text-text" />
          <input
            className="w-full bg-transparent text-[15px] text-text outline-none placeholder:text-subdued"
            placeholder={t("nav.searchPlaceholder")}
          />
        </label>
      </div>

      <div data-tauri-drag-region className="flex h-full flex-1 items-start justify-end">
        <WindowControls />
      </div>
    </header>
  );
}

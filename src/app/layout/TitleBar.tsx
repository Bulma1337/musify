import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Copy, House, Minus, Search, Settings, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { inTauri } from "@/lib/platform";
import { FOCUS_SEARCH_EVENT } from "./shortcuts";

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

const roundButton =
  "grid size-8 place-items-center rounded-full bg-black/40 text-subdued transition-colors hover:text-text";

/** Back/forward, home and the search field. Requires the router. */
function Navigation() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === "/search";
  const [query, setQuery] = useState(onSearchPage ? (params.get("q") ?? "") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the field in sync when leaving or entering the search page via history.
  const urlQuery = onSearchPage ? (params.get("q") ?? "") : "";
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery);
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    setQuery(urlQuery);
  }

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);

  function updateQuery(value: string) {
    setQuery(value);
    const target = value ? `/search?q=${encodeURIComponent(value)}` : "/search";
    navigate(target, { replace: onSearchPage });
  }

  return (
    <>
      <div data-tauri-drag-region className="flex flex-1 items-center gap-2">
        <img src="/navify.svg" alt="" className="mr-2 size-7" draggable={false} />
        <button type="button" className={roundButton} aria-label={t("nav.back")} onClick={() => navigate(-1)}>
          <ChevronLeft size={20} />
        </button>
        <button
          type="button"
          className={roundButton}
          aria-label={t("nav.forward")}
          onClick={() => navigate(1)}
        >
          <ChevronRight size={20} />
        </button>
      </div>

      <div className="flex w-full max-w-[480px] items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/")}
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-full bg-elevated transition-transform hover:scale-105",
            location.pathname === "/" ? "text-text" : "text-subdued hover:text-text",
          )}
          aria-label={t("nav.home")}
        >
          <House size={22} fill={location.pathname === "/" ? "currentColor" : "none"} />
        </button>
        <label className="group flex h-12 flex-1 items-center gap-3 rounded-full bg-elevated px-4 ring-white/20 focus-within:ring-2 hover:bg-highlight">
          <Search size={22} className="shrink-0 text-subdued group-focus-within:text-text" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            onFocus={() =>
              !onSearchPage && navigate(query ? `/search?q=${encodeURIComponent(query)}` : "/search")
            }
            onKeyDown={(e) => e.key === "Escape" && inputRef.current?.blur()}
            className="w-full bg-transparent text-[15px] text-text outline-none placeholder:text-subdued"
            placeholder={t("nav.searchPlaceholder")}
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              aria-label={t("nav.clearSearch")}
              onClick={() => updateQuery("")}
              className="text-subdued hover:text-text"
            >
              <X size={20} />
            </button>
          )}
        </label>
      </div>
    </>
  );
}

/** Opens the settings page. Requires the router. */
function SettingsButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const active = useLocation().pathname === "/settings";
  return (
    <button
      type="button"
      aria-label={t("settings.title")}
      title={t("settings.title")}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate("/settings")}
      className={cn(
        "mx-1 grid size-8 shrink-0 place-items-center self-center rounded-full transition-colors hover:text-text",
        active ? "text-text" : "text-subdued",
      )}
    >
      <Settings size={19} />
    </button>
  );
}

/** Frameless window title bar. `minimal` hides navigation (onboarding, outside the router). */
export function TitleBar({ minimal = false }: { minimal?: boolean }) {
  return (
    <header data-tauri-drag-region className="flex h-16 shrink-0 items-center gap-2 pl-3">
      {minimal ? (
        <div data-tauri-drag-region className="flex flex-1 items-center">
          <img src="/navify.svg" alt="" className="size-7" draggable={false} />
        </div>
      ) : (
        <Navigation />
      )}
      <div data-tauri-drag-region className="flex h-full flex-1 items-start justify-end">
        {!minimal && <SettingsButton />}
        <WindowControls />
      </div>
    </header>
  );
}

import { startUpdateChecks } from "@/features/updates/updater";
import { useSettings } from "@/settings/store";
import { startMediaSession } from "@/player/mediaSession";
import { resumeAtStartup, startQueueSync } from "@/player/resume";
import { NARROW_WINDOW_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { FullscreenPlayer } from "./FullscreenPlayer";
import { MiniPlayer } from "./MiniPlayer";
import { normalizeWindowAtStartup, usePlayerView } from "./playerView";
import { Suspense, useEffect, useState, type PointerEvent } from "react";
import { Outlet, useLocation } from "react-router";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Spinner } from "@/components/ui/Spinner";
import { Toaster } from "@/components/ui/Toaster";
import { DownloadsController } from "@/features/downloads/DownloadsController";
import { OfflineBanner } from "@/features/downloads/OfflineBanner";
import { inTauri } from "@/lib/platform";
import { startEngineBridge } from "@/player/bridge";
import { useAppearance } from "@/settings/appearance";
import { startEngineSettingsSync } from "@/settings/engineSync";
import { LIBRARY_COLLAPSED_WIDTH, useLayout } from "./layoutStore";
import { LibrarySidebar } from "./LibrarySidebar";
import { PlayerBar } from "./PlayerBar";
import { RightPanel } from "./RightPanel";
import { ScrollContainerContext } from "./scrollContainer";
import { TitleBar } from "./TitleBar";
import { useGlobalShortcuts } from "./shortcuts";

/** Draggable gap between panels. `direction` 1 grows the panel when dragging right, -1 when dragging left. */
function ResizeHandle({
  width,
  onResize,
  direction,
}: {
  width: number;
  onResize: (w: number) => void;
  direction: 1 | -1;
}) {
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const startX = e.clientX;
    const startWidth = width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const zoom = useLayout.getState().zoom;
    const move = (ev: globalThis.PointerEvent) =>
      onResize(startWidth + ((ev.clientX - startX) / zoom) * direction);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group relative w-2 shrink-0 cursor-col-resize"
    >
      <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-subdued/60" />
    </div>
  );
}

function useZoom() {
  const zoom = useLayout((s) => s.zoom);
  useEffect(() => {
    if (inTauri) void getCurrentWebview().setZoom(zoom);
    else document.documentElement.style.zoom = String(zoom);
  }, [zoom]);
}

/** Main view with its own scroll container (exposed to virtualized lists and sticky headers). */
function MainView() {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const location = useLocation();

  // New page → start at the top.
  useEffect(() => {
    scrollElement?.scrollTo({ top: 0 });
  }, [location.pathname, scrollElement]);

  return (
    <main ref={setScrollElement} className="relative min-w-0 flex-1 overflow-y-auto rounded-lg bg-surface">
      <ScrollContainerContext.Provider value={scrollElement}>
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-subdued">
              <Spinner size={32} />
            </div>
          }
        >
          {scrollElement && <Outlet />}
        </Suspense>
      </ScrollContainerContext.Provider>
    </main>
  );
}

/** Logged-in layout: title bar, library, main view, right panel, player bar. */
export function AppShell() {
  const narrow = useMediaQuery(NARROW_WINDOW_QUERY);
  const {
    libraryWidth,
    libraryCollapsed: collapsedSetting,
    rightPanel,
    rightWidth,
    setLibraryWidth,
    setRightWidth,
  } = useLayout();
  // Narrow windows show the library as icons only (the setting is kept for wider windows).
  const libraryCollapsed = collapsedSetting || narrow;
  useZoom();
  useGlobalShortcuts();
  useAppearance();
  useEffect(() => startEngineBridge(), []);
  useEffect(() => startEngineSettingsSync(), []);
  useEffect(() => {
    void resumeAtStartup();
    return startQueueSync();
  }, []);
  useEffect(() => startUpdateChecks(() => useSettings.getState().autoUpdate), []);
  useEffect(() => startMediaSession(), []);
  useEffect(() => {
    void normalizeWindowAtStartup();
  }, []);
  const view = usePlayerView((s) => s.view);

  if (view === "mini") {
    return (
      <div className="h-full">
        <MiniPlayer />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <OfflineBanner />
      <div className="flex min-h-0 flex-1 px-2">
        <div
          style={{ width: libraryCollapsed ? LIBRARY_COLLAPSED_WIDTH : libraryWidth }}
          className="shrink-0"
        >
          <LibrarySidebar />
        </div>
        <ResizeHandle
          width={libraryCollapsed ? LIBRARY_COLLAPSED_WIDTH : libraryWidth}
          onResize={setLibraryWidth}
          direction={1}
        />
        <MainView />
        {rightPanel && (
          <>
            <ResizeHandle width={rightWidth} onResize={setRightWidth} direction={-1} />
            <div style={{ width: rightWidth }} className="hidden shrink-0 lg:block">
              <RightPanel />
            </div>
          </>
        )}
      </div>
      <PlayerBar />
      {view === "fullscreen" && <FullscreenPlayer />}
      <Toaster />
      <DownloadsController />
    </div>
  );
}

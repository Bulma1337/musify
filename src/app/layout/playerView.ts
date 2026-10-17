import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { inTauri } from "@/lib/platform";

/** What the window shows: the normal app, the full-screen player or the miniplayer. */
export type PlayerView = "shell" | "fullscreen" | "mini";

const MINI_SIZE = { width: 340, height: 400 };
const MINI_MIN_SIZE = { width: 240, height: 96 };
const SHELL_MIN_SIZE = { width: 800, height: 600 };
const SHELL_DEFAULT_SIZE = { width: 1280, height: 800 };

interface Saved {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

/** Window geometry before the miniplayer shrank it (physical pixels). */
let saved: Saved | null = null;

async function nativeWindow() {
  const [{ getCurrentWindow }, dpi] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/dpi"),
  ]);
  return { win: getCurrentWindow(), dpi };
}

async function setFullscreen(on: boolean) {
  if (inTauri) {
    const { win } = await nativeWindow();
    await win.setFullscreen(on);
    return;
  }
  // Browser preview.
  if (on) await document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

async function shrinkToMini(onTop: boolean) {
  if (!inTauri) return;
  const { win, dpi } = await nativeWindow();
  const maximized = await win.isMaximized();
  const [size, position] = await Promise.all([win.outerSize(), win.outerPosition()]);
  saved = { width: size.width, height: size.height, x: position.x, y: position.y, maximized };
  if (maximized) await win.unmaximize();
  if (await win.isFullscreen()) await win.setFullscreen(false);
  await win.setMinSize(new dpi.LogicalSize(MINI_MIN_SIZE.width, MINI_MIN_SIZE.height));
  await win.setSize(new dpi.LogicalSize(MINI_SIZE.width, MINI_SIZE.height));
  await win.setAlwaysOnTop(onTop);
}

async function restoreFromMini() {
  if (!inTauri) return;
  const { win, dpi } = await nativeWindow();
  await win.setAlwaysOnTop(false);
  await win.setMinSize(new dpi.LogicalSize(SHELL_MIN_SIZE.width, SHELL_MIN_SIZE.height));
  if (saved) {
    await win.setSize(new dpi.PhysicalSize(saved.width, saved.height));
    await win.setPosition(new dpi.PhysicalPosition(saved.x, saved.y));
    if (saved.maximized) await win.maximize();
  } else {
    await win.setSize(new dpi.LogicalSize(SHELL_DEFAULT_SIZE.width, SHELL_DEFAULT_SIZE.height));
  }
  saved = null;
}

interface PlayerViewState {
  view: PlayerView;
  /** The miniplayer stays above other windows (remembered). */
  miniOnTop: boolean;
  openFullscreen(): void;
  openMini(): void;
  /** Back to the normal app from full screen or the miniplayer. */
  backToShell(): void;
  setMiniOnTop(onTop: boolean): void;
}

export const usePlayerView = create<PlayerViewState>()(
  persist(
    (set, get) => ({
      view: "shell",
      miniOnTop: true,
      openFullscreen() {
        if (get().view === "mini") void restoreFromMini();
        set({ view: "fullscreen" });
        void setFullscreen(true);
      },
      openMini() {
        if (get().view === "fullscreen") void setFullscreen(false);
        set({ view: "mini" });
        void shrinkToMini(get().miniOnTop);
      },
      backToShell() {
        const view = get().view;
        set({ view: "shell" });
        if (view === "fullscreen") void setFullscreen(false);
        if (view === "mini") void restoreFromMini();
      },
      setMiniOnTop(onTop) {
        set({ miniOnTop: onTop });
        if (inTauri && get().view === "mini") {
          void nativeWindow().then(({ win }) => win.setAlwaysOnTop(onTop));
        }
      },
    }),
    {
      name: "musify.player-view",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ miniOnTop: s.miniOnTop }),
    },
  ),
);

/**
 * At startup the window may still be small or pinned on top if the app was closed in the miniplayer
 * (the window-state plugin restores that): bring it back to a normal window.
 */
export async function normalizeWindowAtStartup() {
  if (!inTauri) return;
  const { win, dpi } = await nativeWindow();
  await win.setAlwaysOnTop(false);
  await win.setMinSize(new dpi.LogicalSize(SHELL_MIN_SIZE.width, SHELL_MIN_SIZE.height));
  const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  const logical = size.toLogical(scale);
  if (logical.width < SHELL_MIN_SIZE.width || logical.height < SHELL_MIN_SIZE.height) {
    await win.setSize(new dpi.LogicalSize(SHELL_DEFAULT_SIZE.width, SHELL_DEFAULT_SIZE.height));
  }
}

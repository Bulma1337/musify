import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type RightPanel = "nowPlaying" | "queue" | "devices" | null;

export const LIBRARY_COLLAPSED_WIDTH = 72;
export const LIBRARY_MIN_WIDTH = 280;
export const LIBRARY_MAX_WIDTH = 520;
export const RIGHT_MIN_WIDTH = 280;
export const RIGHT_MAX_WIDTH = 420;
export const ZOOM_LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3] as const;

interface LayoutState {
  libraryWidth: number;
  libraryCollapsed: boolean;
  rightPanel: RightPanel;
  rightWidth: number;
  zoom: number;

  setLibraryWidth(width: number): void;
  toggleLibrary(): void;
  /** Opens the panel, or closes it when it is already open. */
  toggleRightPanel(panel: Exclude<RightPanel, null>): void;
  setRightPanel(panel: RightPanel): void;
  setRightWidth(width: number): void;
  setZoom(zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function stepZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_LEVELS.findIndex((z) => Math.abs(z - current) < 0.001);
  const next = clamp((index === -1 ? 3 : index) + direction, 0, ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[next] ?? 1;
}

/** Panel sizes, open panels and zoom; persisted across restarts (UI convenience only). */
export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => ({
      libraryWidth: 340,
      libraryCollapsed: false,
      rightPanel: "nowPlaying",
      rightWidth: 340,
      zoom: 1,

      setLibraryWidth: (width) => {
        // Dragging below the minimum collapses the library, like Spotify.
        if (width < LIBRARY_MIN_WIDTH - 80) set({ libraryCollapsed: true });
        else
          set({ libraryCollapsed: false, libraryWidth: clamp(width, LIBRARY_MIN_WIDTH, LIBRARY_MAX_WIDTH) });
      },
      toggleLibrary: () => set({ libraryCollapsed: !get().libraryCollapsed }),
      toggleRightPanel: (panel) => set({ rightPanel: get().rightPanel === panel ? null : panel }),
      setRightPanel: (panel) => set({ rightPanel: panel }),
      setRightWidth: (width) => set({ rightWidth: clamp(width, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH) }),
      setZoom: (zoom) =>
        set({ zoom: clamp(zoom, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 1.3) }),
      zoomIn: () => set({ zoom: stepZoom(get().zoom, 1) }),
      zoomOut: () => set({ zoom: stepZoom(get().zoom, -1) }),
    }),
    { name: "navify.layout", storage: createJSONStorage(() => localStorage) },
  ),
);

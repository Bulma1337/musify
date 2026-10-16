import { useEffect } from "react";
import { usePlayer } from "@/player/store";
import { useLayout } from "./layoutStore";

/** Event the title bar listens to for focusing the search field. */
export const FOCUS_SEARCH_EVENT = "navify:focus-search";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * App-wide keyboard shortcuts:
 * Space play/pause · Ctrl+→/← next/previous · Ctrl+↑/↓ volume · Ctrl+S shuffle · Ctrl+R repeat
 * Ctrl+K / Ctrl+L search · Ctrl+= / Ctrl+- / Ctrl+0 zoom
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      const player = usePlayer.getState();
      const layout = useLayout.getState();

      if (ctrl && (e.key === "k" || e.key === "l")) {
        e.preventDefault();
        window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
        return;
      }
      if (ctrl && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        layout.zoomIn();
        return;
      }
      if (ctrl && e.key === "-") {
        e.preventDefault();
        layout.zoomOut();
        return;
      }
      if (ctrl && e.key === "0") {
        e.preventDefault();
        layout.setZoom(1);
        return;
      }
      if (isTyping(e.target)) return;

      if (e.key === " " && !ctrl) {
        // Let focused buttons handle Space themselves.
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        player.togglePlay();
      } else if (ctrl && e.key === "ArrowRight") {
        e.preventDefault();
        player.next();
      } else if (ctrl && e.key === "ArrowLeft") {
        e.preventDefault();
        player.previous();
      } else if (ctrl && e.key === "ArrowUp") {
        e.preventDefault();
        player.setVolume(player.volume + 0.1);
      } else if (ctrl && e.key === "ArrowDown") {
        e.preventDefault();
        player.setVolume(player.volume - 0.1);
      } else if (ctrl && e.key === "s") {
        e.preventDefault();
        player.setShuffle(player.shuffle === "off" ? "shuffle" : "off");
      } else if (ctrl && e.key === "r") {
        e.preventDefault();
        player.cycleRepeat();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

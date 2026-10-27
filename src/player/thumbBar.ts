import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useIsStarred, useSetStarred } from "@/api/queries";
import { inTauri } from "@/lib/platform";
import { usePlayer } from "./store";

/**
 * Media buttons in the Windows taskbar thumbnail preview: like, previous, play/pause and next. The
 * native side draws them; this sends the player and favorite state with tooltips in the app
 * language and runs the clicks like the player bar. Other platforms ignore the commands.
 */

export type ThumbBarButton = "like" | "previous" | "toggle" | "next";

export interface ThumbBarState {
  playing: boolean;
  liked: boolean;
  canLike: boolean;
  canToggle: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  labels: { like: string; unlike: string; play: string; pause: string; previous: string; next: string };
}

export function thumbBarState(
  { hasTrack, playing, liked }: { hasTrack: boolean; playing: boolean; liked: boolean },
  t: TFunction,
): ThumbBarState {
  return {
    playing,
    liked,
    // Like the player bar: every button works once a track is loaded (previous restarts it,
    // next at the end stops).
    canLike: hasTrack,
    canToggle: hasTrack,
    hasPrevious: hasTrack,
    hasNext: hasTrack,
    labels: {
      like: t("menu.addToLiked"),
      unlike: t("menu.removeFromLiked"),
      play: t("player.play"),
      pause: t("player.pause"),
      previous: t("player.previous"),
      next: t("player.next"),
    },
  };
}

/** Runs a clicked button like the player bar; `like` goes through `toggleLike`. */
export function applyThumbBarClick(button: ThumbBarButton, toggleLike: () => void) {
  const p = usePlayer.getState();
  switch (button) {
    case "like":
      toggleLike();
      break;
    case "previous":
      p.previous();
      break;
    case "toggle":
      p.togglePlay();
      break;
    case "next":
      p.next();
      break;
  }
}

// Imported up front, not on demand: updates must reach the native side in the order they were made.
function invokeThumbBar(command: string, args?: Record<string, unknown>) {
  void invoke(command, args).catch(() => {});
}

/** Keeps the thumbnail buttons in sync while the app shell is mounted. */
export function useThumbBar() {
  const { t } = useTranslation();
  const track = usePlayer((s) => s.current?.track ?? null);
  const playing = usePlayer((s) => s.isPlaying);
  const liked = useIsStarred("track", track?.id, track?.starred);
  const { mutate: setStarred } = useSetStarred();
  const hasTrack = track !== null;

  useEffect(() => {
    if (!inTauri) return;
    invokeThumbBar("thumbbar_update", { state: thumbBarState({ hasTrack, playing, liked }, t) });
  }, [hasTrack, playing, liked, t]);

  // Hidden again when the shell goes away (signed out).
  useEffect(() => {
    if (!inTauri) return;
    return () => invokeThumbBar("thumbbar_clear");
  }, []);

  const onClick = useEffectEvent((button: ThumbBarButton) =>
    applyThumbBarClick(button, () => {
      if (track) setStarred({ kind: "track", id: track.id, starred: !liked });
    }),
  );

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    let stopped = false;
    void listen<{ button: ThumbBarButton }>("thumbbar-click", (e) => onClick(e.payload.button)).then(
      (off) => {
        if (stopped) off();
        else unlisten = off;
      },
    );
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);
}

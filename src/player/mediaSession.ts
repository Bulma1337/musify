import { useSession } from "@/api/session";
import { inTauri } from "@/lib/platform";
import { usePlayer, type PlayerState } from "./store";

/**
 * Keeps the system media overlay (Windows SMTC, also macOS Now Playing / Linux MPRIS) in sync with
 * the player and turns media keys and overlay buttons into player actions. In the browser preview the
 * Media Session API does the same.
 */

type MediaAction =
  | { action: "play" | "pause" | "toggle" | "next" | "previous" | "stop" }
  | { action: "seekTo"; positionMs: number }
  | { action: "seekBy"; offsetMs: number };

export function applyMediaAction(event: MediaAction) {
  const p = usePlayer.getState();
  switch (event.action) {
    case "play":
      p.setPlaying(true);
      break;
    case "pause":
    case "stop":
      p.setPlaying(false);
      break;
    case "toggle":
      p.togglePlay();
      break;
    case "next":
      p.next();
      break;
    case "previous":
      p.previous();
      break;
    case "seekTo":
      p.seek(Math.max(0, event.positionMs));
      break;
    case "seekBy":
      p.seek(Math.min(Math.max(0, p.positionMs + event.offsetMs), p.durationMs || Infinity));
      break;
  }
}

function coverUrl(state: PlayerState): string | null {
  const track = state.current?.track;
  const provider = useSession.getState().provider;
  return track?.cover && provider ? provider.coverUrl(track.cover, 512) : null;
}

async function invokeMedia(command: string, args: Record<string, unknown> = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(command, args).catch(() => {});
}

export function startMediaSession(): () => void {
  let lastKey: string | null = null;

  const sync = (s: PlayerState, prev?: PlayerState) => {
    const current = s.current;
    if (!current) {
      if (lastKey !== null) {
        lastKey = null;
        if (inTauri) void invokeMedia("media_clear");
        else if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      }
      return;
    }
    const playback = { playing: s.isPlaying, positionMs: Math.round(s.positionMs) };
    if (current.key !== lastKey) {
      lastKey = current.key;
      const track = current.track;
      const provider = useSession.getState().provider;
      if (inTauri) {
        void invokeMedia("media_track", {
          track: {
            title: track.title,
            artist: track.artistLine,
            album: track.album?.name ?? null,
            durationMs: track.durationMs || null,
            coverUrl: coverUrl(s),
            allowInsecureTls: provider?.server.allowInsecureTls ?? false,
          },
        });
        void invokeMedia("media_playback", playback);
      } else if ("mediaSession" in navigator) {
        const cover = coverUrl(s);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artistLine,
          album: track.album?.name ?? "",
          artwork: cover ? [{ src: cover, sizes: "512x512" }] : [],
        });
      }
      return;
    }
    if (!prev || s.isPlaying !== prev.isPlaying || s.seekNonce !== prev.seekNonce) {
      if (inTauri) void invokeMedia("media_playback", playback);
      else if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = s.isPlaying ? "playing" : "paused";
      }
    }
  };

  sync(usePlayer.getState());
  const unsubscribe = usePlayer.subscribe((s, prev) => sync(s, prev));

  let unlisten: (() => void) | undefined;
  if (inTauri) {
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<MediaAction>("media-control", (e) => applyMediaAction(e.payload)).then((off) => {
        unlisten = off;
      }),
    );
  } else if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => applyMediaAction({ action: "play" })],
      ["pause", () => applyMediaAction({ action: "pause" })],
      ["nexttrack", () => applyMediaAction({ action: "next" })],
      ["previoustrack", () => applyMediaAction({ action: "previous" })],
      [
        "seekto",
        (d) =>
          d.seekTime !== undefined && applyMediaAction({ action: "seekTo", positionMs: d.seekTime * 1000 }),
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Not supported by this browser.
      }
    }
    unlisten = () => handlers.forEach(([action]) => ms.setActionHandler(action, null));
  }

  return () => {
    unsubscribe();
    unlisten?.();
  };
}

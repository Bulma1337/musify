import type { MusicProvider, SavedPlayQueue, Track } from "@/api/provider";
import { useSession } from "@/api/session";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { readPersisted, writePersisted } from "@/lib/persist";
import { inTauri } from "@/lib/platform";
import { useSettings } from "@/settings/store";
import { upcomingContextItems, usePlayer, type PlayerState } from "./store";

/**
 * "Continue where you left off": the queue and position are saved locally and (for servers that
 * support it, e.g. Navidrome) on the server via savePlayQueue. At startup, and when the window comes
 * back to the front while nothing plays, the newest saved state wins: a queue another device saved
 * later replaces the local one. If playback stopped at most `resumeWindowMin` minutes ago it
 * continues by itself at the exact position.
 */

const FILE = "player.json";
const META_KEY = "resume";
/** While playing, the position is saved this often. */
const SAVE_EVERY_MS = 15_000;
/** Queue edits are saved after this pause. */
const QUEUE_DEBOUNCE_MS = 2_000;
/** Saved queue size around the current track (servers and URLs have limits). */
const MAX_BEFORE = 200;
const MAX_AFTER = 800;
/** Two saves this close together are the same moment (clock differences between devices). */
const SAME_MOMENT_MS = 5_000;
/** Longest wait for the last save when the window closes. */
const CLOSE_SAVE_TIMEOUT_MS = 1_500;

export interface ResumeMeta {
  /** When the local state was saved (ms since epoch). */
  savedAt: number;
  wasPlaying: boolean;
  serverId: string | null;
}

/** The queue as one flat list in play order with the current track's index. */
export function queueSnapshot(s: PlayerState): { tracks: Track[]; index: number } | null {
  if (!s.current) return null;
  const contextAtIndex = s.contextItems[s.order[s.orderIndex] ?? -1];
  const before = s.order
    .slice(0, s.orderIndex)
    .map((i) => s.contextItems[i]?.track)
    .filter((t): t is Track => !!t);
  // Playing from the manual queue: the context item at the index was already played.
  if (contextAtIndex && contextAtIndex.key !== s.current.key) before.push(contextAtIndex.track);
  const after = [...s.manualQueue, ...upcomingContextItems(s)].map((i) => i.track);
  const head = before.slice(-MAX_BEFORE);
  return { tracks: [...head, s.current.track, ...after.slice(0, MAX_AFTER)], index: head.length };
}

export type ResumeDecision = { action: "adopt"; play: boolean } | { action: "continue" } | { action: "none" };

/** What to do at startup (or on focus) given the local and the server's saved state. */
export function decideResume(input: {
  local: ResumeMeta | null;
  /** When the server's queue was saved (ms), null if there is none. */
  remoteAt: number | null;
  now: number;
  windowMin: number;
  /** The server queue matches what is loaded locally (same track, about the same position). */
  remoteMatchesLocal: boolean;
}): ResumeDecision {
  const { local, remoteAt, now, windowMin, remoteMatchesLocal } = input;
  const windowMs = windowMin * 60_000;
  const recent = (at: number) => windowMs > 0 && now - at <= windowMs;
  if (remoteAt !== null && !remoteMatchesLocal && remoteAt > (local?.savedAt ?? 0) + SAME_MOMENT_MS) {
    return { action: "adopt", play: recent(remoteAt) };
  }
  if (local?.wasPlaying && recent(local.savedAt)) return { action: "continue" };
  return { action: "none" };
}

function remoteMatches(remote: SavedPlayQueue, s: PlayerState): boolean {
  return (
    !!s.current &&
    remote.currentId === s.current.track.id &&
    Math.abs(remote.positionMs - s.positionMs) < SAME_MOMENT_MS
  );
}

async function fetchRemote(provider: MusicProvider | null): Promise<SavedPlayQueue | null> {
  if (!provider?.getPlayQueue || !useSettings.getState().syncPlayQueue || useSession.getState().offline) {
    return null;
  }
  try {
    return await provider.getPlayQueue();
  } catch {
    return null;
  }
}

function adopt(remote: SavedPlayQueue, provider: MusicProvider, play: boolean) {
  const tracks = (remote.tracks ?? []).filter((t) => t.serverId === provider.server.id);
  if (tracks.length === 0) return;
  const index = Math.max(remote.currentId ? tracks.findIndex((t) => t.id === remote.currentId) : 0, 0);
  usePlayer.getState().restoreQueue({
    tracks,
    index,
    positionMs: remote.positionMs,
    context: { type: "queue", name: i18n.t("player.resumedQueue") },
    play,
  });
  const client = remote.changedBy?.trim();
  toast(
    client
      ? i18n.t(play ? "player.resumedFrom" : "player.loadedFrom", { client })
      : i18n.t(play ? "player.resumed" : "player.loaded"),
  );
}

function hydrated(): Promise<void> {
  if (usePlayer.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = usePlayer.persist.onFinishHydration(() => {
      off();
      resolve();
    });
  });
}

/** Startup: continue locally or adopt a newer queue from another device. */
export async function resumeAtStartup(): Promise<void> {
  await hydrated();
  const provider = useSession.getState().provider;
  if (!provider) return;
  const [local, remote] = await Promise.all([
    readPersisted<ResumeMeta>(FILE, META_KEY).catch(() => null),
    fetchRemote(provider),
  ]);
  const remoteAt = remote?.changedAt ? Date.parse(remote.changedAt) : null;
  const s = usePlayer.getState();
  const decision = decideResume({
    local: local && local.serverId === provider.server.id ? local : null,
    remoteAt: remoteAt !== null && Number.isFinite(remoteAt) ? remoteAt : null,
    now: Date.now(),
    windowMin: useSettings.getState().resumeWindowMin,
    remoteMatchesLocal: !!remote && remoteMatches(remote, s),
  });
  if (decision.action === "adopt" && remote) adopt(remote, provider, decision.play);
  else if (decision.action === "continue" && s.current?.track.serverId === provider.server.id) {
    usePlayer.getState().setPlaying(true);
  }
}

/** Saves the local resume state and, if enabled and supported, the queue on the server. */
async function saveNow(): Promise<void> {
  const s = usePlayer.getState();
  const provider = useSession.getState().provider;
  const meta: ResumeMeta = {
    savedAt: Date.now(),
    wasPlaying: s.isPlaying,
    serverId: provider?.server.id ?? null,
  };
  await writePersisted(FILE, META_KEY, meta).catch(() => {});
  if (!provider?.savePlayQueue || !useSettings.getState().syncPlayQueue || useSession.getState().offline) {
    return;
  }
  const snap = queueSnapshot(s);
  const current = snap?.tracks[snap.index];
  if (!snap || !current || current.serverId !== provider.server.id) return;
  await provider
    .savePlayQueue({
      trackIds: snap.tracks.map((t) => t.id),
      currentId: current.id,
      positionMs: s.positionMs,
    })
    .catch(() => {});
}

/** Keeps the saved state current; checks the server when the window comes back. Returns cleanup. */
export function startQueueSync(): () => void {
  let lastSave = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    lastSave = Date.now();
    void saveNow();
  };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(save, delay);
  };

  const unsubscribe = usePlayer.subscribe((s, prev) => {
    if (!s.current && !prev.current) return;
    if (
      s.current?.key !== prev.current?.key ||
      s.isPlaying !== prev.isPlaying ||
      s.seekNonce !== prev.seekNonce
    ) {
      schedule(300);
    } else if (
      s.manualQueue !== prev.manualQueue ||
      s.order !== prev.order ||
      s.contextItems !== prev.contextItems
    ) {
      schedule(QUEUE_DEBOUNCE_MS);
    } else if (s.isPlaying && s.positionMs !== prev.positionMs && Date.now() - lastSave >= SAVE_EVERY_MS) {
      schedule(0);
    }
  });

  // Back at the computer while nothing plays: maybe another device went on in the meantime.
  let checking = false;
  const onFront = () => {
    if (document.visibilityState !== "visible" || usePlayer.getState().isPlaying || checking) return;
    checking = true;
    void (async () => {
      try {
        const provider = useSession.getState().provider;
        const remote = await fetchRemote(provider);
        if (!provider || !remote) return;
        const remoteAt = remote.changedAt ? Date.parse(remote.changedAt) : NaN;
        if (!Number.isFinite(remoteAt) || remoteAt <= lastSave + SAME_MOMENT_MS) return;
        if (remoteMatches(remote, usePlayer.getState())) return;
        adopt(remote, provider, false);
      } finally {
        checking = false;
      }
    })();
  };
  window.addEventListener("focus", onFront);
  document.addEventListener("visibilitychange", onFront);

  // Last save when the window closes.
  let unlistenClose: (() => void) | undefined;
  if (inTauri) {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onCloseRequested(async () => {
          clearTimeout(timer);
          await Promise.race([saveNow(), new Promise((r) => setTimeout(r, CLOSE_SAVE_TIMEOUT_MS))]);
        })
        .then((off) => {
          unlistenClose = off;
        }),
    );
  } else {
    window.addEventListener("beforeunload", save);
  }

  return () => {
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener("focus", onFront);
    document.removeEventListener("visibilitychange", onFront);
    window.removeEventListener("beforeunload", save);
    unlistenClose?.();
  };
}

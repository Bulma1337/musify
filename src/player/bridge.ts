import { create } from "zustand";
import type { Track } from "@/api/provider";
import { useSession } from "@/api/session";
import { toastError } from "@/components/ui/toast";
import { useDownloads } from "@/features/downloads/store";
import i18n from "@/i18n";
import { currentStreamQuality, useSettings } from "@/settings/store";
import { recordPlay } from "@/features/stats/recorder";
import { audioEngine } from "./engine";
import type { EngineEvent, OutputFormat, SourceFormat, SourceLocation, TrackSource } from "./engineTypes";
import { peekNext, usePlayer, type PlayerState, type QueueItem } from "./store";

/** What the engine reports about the signal path (quality badge, bit-perfect indicator). */
interface EngineStatus {
  sourceFormat: SourceFormat | null;
  outputFormat: OutputFormat | null;
}

export const useEngineStatus = create<EngineStatus>(() => ({ sourceFormat: null, outputFormat: null }));

/** A listen counts as a play after half the track or 4 minutes, and at least 30 seconds. */
export function shouldScrobble(playedMs: number, durationMs: number): boolean {
  return playedMs >= 30_000 && playedMs >= Math.min(durationMs / 2, 240_000);
}

/** Engine ids are queue keys; repeats of the same entry get a `#n` suffix. */
const baseKey = (id: string) => id.split("#")[0] ?? id;

/** Where the engine reads a track from: the downloaded file if there is one, otherwise the stream. */
export function sourceLocation(track: Track): SourceLocation | null {
  const local = useDownloads.getState().localPath(track.serverId, track.id);
  if (local) return { kind: "local", path: local };
  const provider = useSession.getState().provider;
  if (!provider) return null;
  let stream;
  try {
    stream = provider.getStreamSource(track, currentStreamQuality());
  } catch {
    // Offline mode: tracks that are not downloaded can't be played.
    return null;
  }
  return {
    kind: "http",
    url: stream.url,
    headers: Object.entries(stream.headers),
    cacheKey: stream.cacheKey,
    transcoded: stream.transcoded,
    containerHint: stream.container ?? null,
    timeOffset: stream.timeOffset ?? null,
    allowInsecureTls: provider.server.allowInsecureTls ?? false,
  };
}

function toSource(id: string, track: Track, state: PlayerState): TrackSource | null {
  const location = sourceLocation(track);
  if (!location) return null;
  const rg = track.replayGain;
  return {
    id,
    location,
    gain: rg
      ? {
          trackGainDb: rg.trackGain ?? null,
          albumGainDb: rg.albumGain ?? null,
          trackPeak: rg.trackPeak ?? null,
          albumPeak: rg.albumPeak ?? null,
        }
      : null,
    durationHintMs: track.durationMs || null,
    // Album playback: same-album tracks stay gapless (no crossfade) and may use album gain.
    albumKey: state.context?.type === "album" ? (track.album?.id ?? null) : null,
  };
}

/**
 * Connects the player store with the audio engine. Returns a cleanup function.
 * User intent (start/seek nonces, play/pause, volume) goes to the engine; engine events update the
 * store inside `apply`, which the store listener ignores, so nothing loops.
 */
export function startEngineBridge(): () => void {
  const engine = audioEngine();
  let applying = false;
  let repeatCounter = 0;
  let nextId: string | null = null;
  let lastProgressReport = 0;
  /** Queue key the engine has loaded (after a restart nothing is loaded until the first play). */
  let loadedKey: string | null = null;
  let autoplayPending = false;

  /** Autoplay: when nothing follows, continue with similar tracks (or random ones of the genre). */
  async function autoplay(state: PlayerState) {
    const provider = useSession.getState().provider;
    const track = state.current?.track;
    if (!provider || !track || autoplayPending || !useSettings.getState().autoplay) return;
    if (peekNext(state) || state.repeat !== "off") return;
    autoplayPending = true;
    try {
      let tracks = provider.capabilities.similarTracks ? await provider.getSimilarTracks(track.id, 25) : [];
      if (tracks.length === 0) {
        tracks = await provider.getRandomTracks({ size: 25, genre: track.genres[0] });
      }
      usePlayer.getState().appendRecommendations(tracks);
    } catch {
      // No autoplay this time; playback simply ends.
    } finally {
      autoplayPending = false;
    }
  }
  /** Tracks that started recently, by engine id (for scrobbling and the listening history when they end). */
  const started = new Map<
    string,
    { track: Track; startedAt: number; context: { type?: string; id?: string } }
  >();

  const apply = (fn: () => void) => {
    applying = true;
    try {
      fn();
    } finally {
      applying = false;
    }
  };

  const reportPlayback = (
    event: Parameters<NonNullable<ReturnType<typeof useSession.getState>["provider"]>["reportPlayback"]>[0],
  ) => {
    void useSession
      .getState()
      .provider?.reportPlayback(event)
      .catch(() => {});
  };

  function syncNext(state: PlayerState, force = false) {
    const item: QueueItem | null = peekNext(state);
    if (!item) {
      if (nextId !== null || force) engine.send({ type: "setNext", track: null });
      nextId = null;
      return;
    }
    const wanted = item.key === state.current?.key ? `${item.key}#${++repeatCounter}` : item.key;
    if (!force && nextId !== null && baseKey(nextId) === item.key && item.key !== state.current?.key) return;
    const source = toSource(wanted, item.track, state);
    if (!source) return;
    nextId = wanted;
    engine.send({ type: "setNext", track: source });
  }

  function play(state: PlayerState) {
    if (!state.current) return;
    loadedKey = state.current.key;
    const source = toSource(state.current.key, state.current.track, state);
    if (!source) return;
    nextId = null;
    engine.send({
      type: "play",
      track: source,
      startMs: Math.round(state.positionMs),
      paused: !state.isPlaying,
    });
    syncNext(usePlayer.getState(), true);
  }

  function onEvent(event: EngineEvent) {
    const state = usePlayer.getState();
    switch (event.type) {
      case "trackStarted": {
        const key = baseKey(event.id);
        loadedKey = key;
        const item = state.current?.key === key ? state.current : peekNext(state);
        if (item && item.key === key) {
          const context = usePlayer.getState().context;
          started.set(event.id, {
            track: item.track,
            startedAt: Date.now(),
            context: { type: context?.type, id: context?.id },
          });
        }
        apply(() => {
          if (state.current?.key !== key || event.id.includes("#")) usePlayer.getState().advanceTo(key);
          usePlayer.getState().setProgress(0, event.durationMs ?? item?.track.durationMs);
          usePlayer.getState().setBuffering(false);
        });
        useEngineStatus.setState({ sourceFormat: event.format.codec ? event.format : null });
        if (item) reportPlayback({ type: "start", trackId: item.track.id, positionMs: 0 });
        nextId = null;
        syncNext(usePlayer.getState());
        break;
      }
      case "position":
        if (baseKey(event.id) === state.current?.key) {
          apply(() => usePlayer.getState().setProgress(event.positionMs, event.durationMs ?? undefined));
          // Periodic progress (Jellyfin shows it in its session list; Subsonic ignores it).
          if (event.positionMs - lastProgressReport >= 10_000 || event.positionMs < lastProgressReport) {
            lastProgressReport = event.positionMs;
            reportPlayback({
              type: "progress",
              trackId: state.current.track.id,
              positionMs: event.positionMs,
              paused: !state.isPlaying,
            });
          }
        }
        break;
      case "stateChanged":
        apply(() => {
          if (event.state === "playing") usePlayer.getState().setPlaying(true);
          else if (event.state === "paused") usePlayer.getState().setPlaying(false);
          else if (event.state === "stopped") {
            loadedKey = null;
            usePlayer.getState().finished();
          }
        });
        break;
      case "buffering":
        apply(() => usePlayer.getState().setBuffering(event.active));
        break;
      case "needNext":
        syncNext(state, true);
        void autoplay(state);
        break;
      case "trackEnded": {
        const entry = started.get(event.id);
        started.delete(event.id);
        if (!entry) break;
        const { track } = entry;
        const counted = shouldScrobble(event.playedMs, track.durationMs);
        reportPlayback({ type: "stop", trackId: track.id, positionMs: event.playedMs });
        if (counted) reportPlayback({ type: "scrobble", trackId: track.id, playedAt: new Date() });
        // Local listening history; never throws and never waits, so playback is not affected.
        recordPlay(track, {
          startedAt: entry.startedAt,
          playedMs: event.playedMs,
          completed: event.completed,
          counted,
          context: entry.context,
        });
        break;
      }
      case "error":
        toastError(i18n.t("player.playbackError", { message: event.message }));
        // A failing stream may mean the server is gone: switch to offline mode if so.
        if (event.kind === "network") void useSession.getState().checkConnection();
        break;
      case "outputChanged":
        useEngineStatus.setState({ outputFormat: event.format });
        break;
      case "deviceLost":
        toastError(i18n.t("player.deviceLost"));
        break;
    }
  }

  engine.subscribe(onEvent);
  const initial = usePlayer.getState();
  engine.send({ type: "setVolume", volume: initial.muted ? 0 : initial.volume });

  const unsubscribe = usePlayer.subscribe((state, prev) => {
    if (applying) return;
    if (!state.current && prev.current) {
      // Queue emptied (e.g. another server): stop and forget what the engine had loaded.
      loadedKey = null;
      nextId = null;
      engine.send({ type: "stop" });
      return;
    }
    if (state.startNonce !== prev.startNonce) {
      play(state);
      return;
    }
    if (state.seekNonce !== prev.seekNonce) {
      engine.send({ type: "seek", positionMs: Math.round(state.positionMs) });
    }
    if (state.isPlaying !== prev.isPlaying && state.current) {
      if (state.isPlaying && loadedKey !== state.current.key) {
        // Restored queue after a restart (or a finished queue): load the track at its position.
        play(state);
        return;
      }
      engine.send({ type: state.isPlaying ? "resume" : "pause" });
    }
    if (state.volume !== prev.volume || state.muted !== prev.muted) {
      engine.send({ type: "setVolume", volume: state.muted ? 0 : state.volume });
    }
    if (
      state.manualQueue !== prev.manualQueue ||
      state.order !== prev.order ||
      state.repeat !== prev.repeat ||
      state.contextItems !== prev.contextItems
    ) {
      syncNext(state);
    }
  });

  return unsubscribe;
}

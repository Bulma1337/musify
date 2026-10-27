import { create } from "zustand";
import type { Track } from "@/api/provider";
import { useSession } from "@/api/session";
import { toastError } from "@/components/ui/toast";
import { useDownloads } from "@/features/downloads/store";
import i18n from "@/i18n";
import { currentStreamQuality, useSettings } from "@/settings/store";
import { recordPlay } from "@/features/stats/recorder";
import { audioEngine } from "./engine";
import type {
  EngineCommand,
  EngineEvent,
  ErrorKind,
  OutputFormat,
  SourceFormat,
  SourceLocation,
  TrackSource,
} from "./engineTypes";
import { networkApi, useNetwork, type EndReason, type RemoteCommand, type SessionInfo } from "./network";
import { chooseRemoteFormat, playableMime } from "./networkFormat";
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

/** The track an engine id refers to: the current one or the one after it. */
function trackOf(state: PlayerState, id: string | null): Track | undefined {
  if (!id) return undefined;
  const key = baseKey(id);
  if (state.current?.key === key) return state.current.track;
  const next = peekNext(state);
  return next?.key === key ? next.track : undefined;
}

/** Toast text for an engine error, naming the track when it is known. */
export function playbackErrorText(kind: ErrorKind, message: string, track?: Track): string {
  if (!track) return i18n.t("player.playbackError", { message });
  if (kind === "server") return i18n.t("player.trackUnavailable", { title: track.title });
  return i18n.t("player.trackUnplayable", { title: track.title, message });
}

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

/**
 * The source for a network speaker: the original where the device plays it (downloaded file or
 * stream), otherwise a server transcode; plus what the device shows. The URLs may carry credentials;
 * the backend hands the device proxy URLs only.
 */
export function remoteSource(id: string, track: Track, device: SessionInfo): TrackSource | null {
  const provider = useSession.getState().provider;
  const insecure = provider?.server.allowInsecureTls ?? false;
  const choice = chooseRemoteFormat(track.format, device, currentStreamQuality());
  const downloaded = useDownloads.getState().localPath(track.serverId, track.id);
  // Downloads may be stored transcoded: their own extension says what they are.
  const downloadedMime = downloaded
    ? playableMime(downloaded.split(".").pop()?.toLowerCase() ?? "", device.mimes)
    : null;
  let location: SourceLocation | null = null;
  let mime = choice.mime;
  if (downloaded && downloadedMime && choice.original) {
    location = { kind: "local", path: downloaded };
    mime = downloadedMime;
  } else if (provider) {
    try {
      const stream = provider.getStreamSource(track, choice.quality);
      location = {
        kind: "http",
        url: stream.url,
        headers: Object.entries(stream.headers),
        cacheKey: stream.cacheKey,
        transcoded: stream.transcoded,
        containerHint: stream.container ?? null,
        timeOffset: stream.timeOffset ?? null,
        allowInsecureTls: insecure,
      };
    } catch {
      // Offline: only a downloaded file can play, even in a format the device may not list.
    }
  }
  if (!location && downloaded) {
    location = { kind: "local", path: downloaded };
    mime = downloadedMime ?? choice.mime;
  }
  if (!location) return null;
  const artists = track.artists.map((a) => a.name).join(", ");
  return {
    id,
    location,
    gain: null,
    durationHintMs: track.durationMs || null,
    albumKey: null,
    remote: {
      mime,
      title: track.title,
      artist: artists || null,
      album: track.album?.name ?? null,
      cover:
        track.cover && provider
          ? { url: provider.coverUrl(track.cover, 600), headers: [], allowInsecureTls: insecure }
          : null,
    },
  };
}

function localSource(id: string, track: Track, state: PlayerState): TrackSource | null {
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

/** Switching between this computer and a network speaker, provided by the running bridge. */
interface BridgeControl {
  toNetwork(info: SessionInfo): void;
  toLocal(resume: boolean): Promise<void>;
}

let control: BridgeControl | null = null;

/** Plays on a network speaker from now on, continuing there at the current position. */
export async function connectNetworkDevice(deviceId: string): Promise<void> {
  const network = useNetwork.getState();
  if (network.connecting || network.active?.device.id === deviceId) return;
  const name = network.devices.find((d) => d.id === deviceId)?.name ?? "";
  useNetwork.setState({ connecting: deviceId });
  try {
    const info = await networkApi.connect(deviceId);
    useNetwork.setState({ active: info, connecting: null });
    control?.toNetwork(info);
  } catch {
    useNetwork.setState({ connecting: null });
    toastError(i18n.t("output.network.connectFailed", { name }));
  }
}

/** Back to this computer: stops the speaker and continues here at the same position. */
export async function disconnectNetworkDevice(): Promise<void> {
  if (!useNetwork.getState().active) return;
  await control?.toLocal(usePlayer.getState().isPlaying);
}

/**
 * Connects the player store with the audio engine, or with a network speaker while one is active.
 * Returns a cleanup function.
 * User intent (start/seek nonces, play/pause, volume) goes to the engine; engine events update the
 * store inside `apply`, which the store listener ignores, so nothing loops.
 */
export function startEngineBridge(): () => void {
  const local = audioEngine();
  /** Where playback runs. Events of the other target are ignored, except for the listening history. */
  let target: "local" | "network" = "local";
  let device: SessionInfo | null = null;
  /** This computer's volume while a speaker uses the volume control. */
  let savedVolume: { volume: number; muted: boolean } | null = null;
  const send = (command: EngineCommand) => {
    if (target === "network") networkApi.send(command as RemoteCommand);
    else local.send(command);
  };
  const toSource = (id: string, track: Track, state: PlayerState) =>
    target === "network" && device ? remoteSource(id, track, device) : localSource(id, track, state);
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
  /**
   * Tracks that started recently, by target and engine id (for scrobbling and the listening history
   * when they end).
   */
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
      if (nextId !== null || force) send({ type: "setNext", track: null });
      nextId = null;
      return;
    }
    const wanted = item.key === state.current?.key ? `${item.key}#${++repeatCounter}` : item.key;
    if (!force && nextId !== null && baseKey(nextId) === item.key && item.key !== state.current?.key) return;
    const source = toSource(wanted, item.track, state);
    if (!source) return;
    nextId = wanted;
    send({ type: "setNext", track: source });
  }

  function play(state: PlayerState) {
    if (!state.current) return;
    loadedKey = state.current.key;
    const source = toSource(state.current.key, state.current.track, state);
    if (!source) return;
    nextId = null;
    send({
      type: "play",
      track: source,
      startMs: Math.round(state.positionMs),
      paused: !state.isPlaying,
    });
    syncNext(usePlayer.getState(), true);
  }

  function onEvent(event: EngineEvent, from: "local" | "network") {
    const state = usePlayer.getState();
    switch (event.type) {
      case "trackStarted": {
        const key = baseKey(event.id);
        loadedKey = key;
        const item = state.current?.key === key ? state.current : peekNext(state);
        if (item && item.key === key) {
          const context = usePlayer.getState().context;
          started.set(`${from}:${event.id}`, {
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
        const entry = started.get(`${from}:${event.id}`);
        started.delete(`${from}:${event.id}`);
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
      case "error": {
        toastError(playbackErrorText(event.kind, event.message, trackOf(state, event.id)));
        if (event.kind === "network") {
          // A failing stream may mean the server is gone: switch to offline mode if so.
          void useSession.getState().checkConnection();
        } else if (event.id !== null && event.id === nextId) {
          // The track after the current one can't be played (gone from the server, broken file):
          // step over it. The engine asks for a next track again (needNext) and gets the one after.
          const failed = event.id;
          nextId = null;
          apply(() => usePlayer.getState().skipUpcoming(baseKey(failed)));
        }
        break;
      }
      case "outputChanged":
        useEngineStatus.setState({ outputFormat: event.format });
        break;
      case "deviceLost":
        toastError(i18n.t("player.deviceLost"));
        break;
    }
  }

  function onSessionEnded(reason: EndReason) {
    const network = useNetwork.getState();
    // Replaced by another speaker: the new session takes over.
    if (reason.kind === "closed" && network.connecting) return;
    if (target !== "network") {
      useNetwork.setState({ active: null });
      return;
    }
    const name = network.active?.device.name ?? "";
    if (reason.kind === "lost") toastError(i18n.t("output.network.lost", { name }));
    if (reason.kind === "takenOver") toastError(i18n.t("output.network.takenOver", { name }));
    void toLocal(false);
  }

  function toNetwork(info: SessionInfo) {
    const state = usePlayer.getState();
    if (target === "local") {
      savedVolume = { volume: state.volume, muted: state.muted };
      local.send({ type: "stop" });
    }
    target = "network";
    device = info;
    loadedKey = null;
    nextId = null;
    useEngineStatus.setState({ sourceFormat: null, outputFormat: null });
    // The slider shows the speaker's own volume; a device that doesn't report one keeps its level.
    if (info.volume !== null) {
      const volume = info.volume;
      apply(() => usePlayer.getState().setVolume(volume));
    }
    if (state.current) play(usePlayer.getState());
  }

  async function toLocal(resume: boolean) {
    if (target === "local") return;
    target = "local";
    device = null;
    loadedKey = null;
    nextId = null;
    useNetwork.setState({ active: null });
    await networkApi.disconnect().catch(() => {});
    if (target !== "local") return;
    const saved = savedVolume;
    savedVolume = null;
    if (saved) {
      apply(() => {
        usePlayer.getState().setVolume(saved.volume);
        if (saved.muted) usePlayer.getState().toggleMute();
      });
    }
    const state = usePlayer.getState();
    local.send({ type: "setVolume", volume: state.muted ? 0 : state.volume });
    apply(() => usePlayer.getState().setPlaying(resume));
    if (state.current) play(usePlayer.getState());
  }

  local.subscribe((event) => {
    if (target === "local" || event.type === "trackEnded") onEvent(event, "local");
  });
  networkApi.subscribe((event) => {
    switch (event.type) {
      case "devices":
        useNetwork.setState({ devices: event.devices });
        break;
      case "scanning":
        useNetwork.setState({ scanning: event.active });
        break;
      case "engine":
        if (target === "network" || event.event.type === "trackEnded") onEvent(event.event, "network");
        break;
      case "sessionEnded":
        onSessionEnded(event.reason);
        break;
    }
  });
  control = { toNetwork, toLocal };
  const initial = usePlayer.getState();
  send({ type: "setVolume", volume: initial.muted ? 0 : initial.volume });

  const unsubscribe = usePlayer.subscribe((state, prev) => {
    if (applying) return;
    if (!state.current && prev.current) {
      // Queue emptied (e.g. another server): stop and forget what the engine had loaded.
      loadedKey = null;
      nextId = null;
      send({ type: "stop" });
      return;
    }
    if (state.startNonce !== prev.startNonce) {
      play(state);
      return;
    }
    if (state.seekNonce !== prev.seekNonce) {
      send({ type: "seek", positionMs: Math.round(state.positionMs) });
    }
    if (state.isPlaying !== prev.isPlaying && state.current) {
      if (state.isPlaying && loadedKey !== state.current.key) {
        // Restored queue after a restart (or a finished queue): load the track at its position.
        play(state);
        return;
      }
      send({ type: state.isPlaying ? "resume" : "pause" });
    }
    if (state.volume !== prev.volume || state.muted !== prev.muted) {
      send({ type: "setVolume", volume: state.muted ? 0 : state.volume });
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

  return () => {
    unsubscribe();
    if (control?.toNetwork === toNetwork) control = null;
  };
}

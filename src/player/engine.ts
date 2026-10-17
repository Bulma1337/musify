import { Channel, invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform";
import type {
  DeviceInfo,
  EngineCommand,
  EngineEvent,
  EqConfig,
  EqResponse,
  SpectrumFrame,
  TrackSource,
} from "./engineTypes";

/** The audio engine as seen by the UI. */
export interface AudioEngineClient {
  send(command: EngineCommand): void;
  /** Registers the (single) event listener. */
  subscribe(listener: (event: EngineEvent) => void): void;
  subscribeSpectrum(listener: (frame: SpectrumFrame) => void): void;
  devices(): Promise<DeviceInfo[]>;
  eqResponse(config: EqConfig, points: number): Promise<EqResponse | null>;
  parseAutoEq(text: string): Promise<EqConfig>;
}

/** Native engine in the Tauri backend. */
class NativeEngine implements AudioEngineClient {
  send(command: EngineCommand) {
    void invoke("audio_send", { command });
  }

  subscribe(listener: (event: EngineEvent) => void) {
    const channel = new Channel<EngineEvent>();
    channel.onmessage = listener;
    void invoke("audio_subscribe", { onEvent: channel });
  }

  subscribeSpectrum(listener: (frame: SpectrumFrame) => void) {
    const channel = new Channel<SpectrumFrame>();
    channel.onmessage = listener;
    void invoke("audio_spectrum_subscribe", { onFrame: channel });
  }

  devices() {
    return invoke<DeviceInfo[]>("audio_devices");
  }

  eqResponse(config: EqConfig, points: number) {
    return invoke<EqResponse>("audio_eq_response", { config, points });
  }

  parseAutoEq(text: string) {
    return invoke<EqConfig>("audio_parse_autoeq", { text });
  }
}

/**
 * Browser-preview fallback (no Tauri): plays through an <audio> element via the dev proxy so the UI
 * can be developed with sound. No gapless, no DSP — the real engine lives in Rust.
 */
class WebPreviewEngine implements AudioEngineClient {
  private audio = new Audio();
  private listener: (event: EngineEvent) => void = () => {};
  private currentId: string | null = null;
  private nextSource: { id: string; url: string; durationMs: number | null } | null = null;
  private lastPosition = 0;

  constructor() {
    this.audio.addEventListener("timeupdate", () => {
      if (!this.currentId) return;
      const positionMs = Math.round(this.audio.currentTime * 1000);
      if (Math.abs(positionMs - this.lastPosition) < 100) return;
      this.lastPosition = positionMs;
      const duration = Number.isFinite(this.audio.duration) ? Math.round(this.audio.duration * 1000) : null;
      this.listener({
        type: "position",
        id: this.currentId,
        positionMs,
        durationMs: duration,
        bufferedMs: null,
      });
    });
    this.audio.addEventListener("playing", () => this.listener({ type: "stateChanged", state: "playing" }));
    this.audio.addEventListener("pause", () => this.listener({ type: "stateChanged", state: "paused" }));
    this.audio.addEventListener("waiting", () => this.listener({ type: "buffering", active: true }));
    this.audio.addEventListener("canplay", () => this.listener({ type: "buffering", active: false }));
    this.audio.addEventListener("ended", () => {
      const ended = this.currentId;
      if (ended) {
        this.listener({ type: "trackEnded", id: ended, playedMs: this.lastPosition, completed: true });
      }
      if (this.nextSource) {
        this.start(this.nextSource.id, this.nextSource.url, 0, false, "gapless", this.nextSource.durationMs);
        this.nextSource = null;
      } else {
        this.currentId = null;
        this.listener({ type: "stateChanged", state: "stopped" });
      }
    });
  }

  private urlOf(track: TrackSource): string {
    const location = track.location;
    return location.kind === "http" ? `/__proxy?url=${encodeURIComponent(location.url)}` : location.path;
  }

  private start(
    id: string,
    url: string,
    startMs: number,
    paused: boolean,
    transition: "manual" | "gapless",
    durationMs: number | null,
  ) {
    this.currentId = id;
    this.lastPosition = startMs;
    this.audio.src = url;
    this.audio.currentTime = startMs / 1000;
    this.listener({
      type: "trackStarted",
      id,
      transition,
      durationMs,
      format: {
        codec: "",
        sampleRate: 0,
        bitsPerSample: null,
        channels: 2,
        bitrateKbps: null,
        lossless: false,
      },
    });
    if (!paused) void this.audio.play().catch(() => {});
  }

  send(command: EngineCommand) {
    switch (command.type) {
      case "play":
        if (this.currentId) {
          this.listener({
            type: "trackEnded",
            id: this.currentId,
            playedMs: this.lastPosition,
            completed: false,
          });
        }
        this.start(
          command.track.id,
          this.urlOf(command.track),
          command.startMs,
          command.paused,
          "manual",
          command.track.durationHintMs,
        );
        break;
      case "setNext":
        this.nextSource = command.track
          ? {
              id: command.track.id,
              url: this.urlOf(command.track),
              durationMs: command.track.durationHintMs,
            }
          : null;
        break;
      case "pause":
        this.audio.pause();
        break;
      case "resume":
        void this.audio.play().catch(() => {});
        break;
      case "stop":
        this.audio.pause();
        this.currentId = null;
        this.listener({ type: "stateChanged", state: "stopped" });
        break;
      case "seek":
        this.audio.currentTime = command.positionMs / 1000;
        break;
      case "skipToNext":
        if (this.nextSource) {
          this.start(this.nextSource.id, this.nextSource.url, 0, false, "manual", this.nextSource.durationMs);
          this.nextSource = null;
        }
        break;
      case "setVolume":
        // Same perceptual curve idea as the native engine: ~ -60 dB … 0 dB.
        this.audio.volume = command.volume <= 0 ? 0 : Math.pow(10, (60 * (command.volume - 1)) / 20);
        break;
      default:
        break;
    }
  }

  subscribe(listener: (event: EngineEvent) => void) {
    this.listener = listener;
  }

  subscribeSpectrum() {}

  async devices(): Promise<DeviceInfo[]> {
    return [];
  }

  async eqResponse() {
    return null;
  }

  async parseAutoEq(): Promise<EqConfig> {
    throw new Error("AutoEQ import needs the desktop app");
  }
}

let instance: AudioEngineClient | null = null;

/** The engine for this window (native in Tauri, `<audio>` fallback in the browser preview). */
export function audioEngine(): AudioEngineClient {
  instance ??= inTauri ? new NativeEngine() : new WebPreviewEngine();
  return instance;
}

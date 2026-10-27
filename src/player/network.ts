import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { inTauri } from "@/lib/platform";
import type { EngineCommand, EngineEvent } from "./engineTypes";

/**
 * Network speakers (`src-tauri/src/network.rs`, crate `musify-cast`): devices on the LAN that play
 * the queue. Types mirror the Rust side (serde, camelCase).
 */

export type NetworkProtocol = "upnp" | "cast";
export type NetworkDeviceKind = "speaker" | "tv" | "group";

export interface NetworkDevice {
  id: string;
  name: string;
  protocol: NetworkProtocol;
  kind: NetworkDeviceKind;
  model: string | null;
}

export interface SessionInfo {
  device: NetworkDevice;
  /** Audio MIME types the device plays; empty = unknown. */
  mimes: string[];
  maxSampleRate: number | null;
  /** Device volume 0…1, if it reports one. */
  volume: number | null;
}

export type EndReason =
  { kind: "closed" } | { kind: "lost"; message: string } | { kind: "takenOver" } | { kind: "turnedOff" };

export type NetworkEvent =
  | { type: "devices"; devices: NetworkDevice[] }
  | { type: "scanning"; active: boolean }
  | { type: "engine"; event: EngineEvent }
  | { type: "sessionEnded"; reason: EndReason };

/** Playback commands for the device: the engine's, with `remote` set on each track. */
export type RemoteCommand = Extract<
  EngineCommand,
  { type: "play" | "setNext" | "pause" | "resume" | "stop" | "seek" | "skipToNext" | "setVolume" }
>;

interface NetworkState {
  devices: NetworkDevice[];
  scanning: boolean;
  /** Connecting to this device (id). */
  connecting: string | null;
  /** Playback runs on this device. */
  active: SessionInfo | null;
}

export const useNetwork = create<NetworkState>(() => ({
  devices: [],
  scanning: false,
  connecting: null,
  active: null,
}));

/** Calls into the backend; no-ops in the browser preview. */
export const networkApi = {
  setEnabled(enabled: boolean): Promise<void> {
    return inTauri ? invoke("network_set_enabled", { enabled }) : Promise.resolve();
  },
  scan(): Promise<void> {
    return inTauri ? invoke("network_scan") : Promise.resolve();
  },
  connect(deviceId: string): Promise<SessionInfo> {
    return inTauri
      ? invoke<SessionInfo>("network_connect", { deviceId })
      : Promise.reject(new Error("Network speakers need the desktop app"));
  },
  disconnect(): Promise<void> {
    return inTauri ? invoke("network_disconnect") : Promise.resolve();
  },
  send(command: RemoteCommand): void {
    if (inTauri) void invoke("network_send", { command });
  },
  /** Registers the (single) listener; a newer subscription replaces it. */
  subscribe(listener: (event: NetworkEvent) => void): void {
    if (!inTauri) return;
    const channel = new Channel<NetworkEvent>();
    channel.onmessage = listener;
    void invoke("network_subscribe", { onEvent: channel });
  },
};

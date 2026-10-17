import { audioEngine } from "@/player/engine";
import type { SpectrumFrame } from "@/player/engineTypes";

const listeners = new Set<(frame: SpectrumFrame) => void>();
let channelOpen = false;

/**
 * Subscribes to analyzer frames. The engine only computes the spectrum while someone listens: the
 * first listener switches it on, the last one switches it off. The engine channel itself is opened
 * once and fanned out here, so pages can mount and unmount freely.
 */
export function listenToSpectrum(listener: (frame: SpectrumFrame) => void): () => void {
  const engine = audioEngine();
  if (!channelOpen) {
    channelOpen = true;
    engine.subscribeSpectrum((frame) => {
      for (const l of listeners) l(frame);
    });
  }
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) engine.send({ type: "setSpectrum", enabled: true });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) engine.send({ type: "setSpectrum", enabled: false });
  };
}

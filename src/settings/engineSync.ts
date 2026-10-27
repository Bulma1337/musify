import { cacheApi } from "@/features/downloads/api";
import { GIGABYTE } from "@/features/downloads/types";
import { disconnectNetworkDevice } from "@/player/bridge";
import { audioEngine } from "@/player/engine";
import { networkApi } from "@/player/network";
import { useSettings } from "./store";

/** Turning network speakers off first moves playback back to this computer, then cuts the network. */
async function applyNetworkSpeakers(enabled: boolean) {
  if (!enabled) await disconnectNetworkDevice();
  await networkApi.setEnabled(enabled).catch(() => {});
}

/**
 * Keeps the audio engine configured from the settings store: DSP, normalization, crossfade and
 * output device, and network speakers on or off. Sends everything once (after settings were loaded)
 * and then only what changed.
 */
export function startEngineSettingsSync(): () => void {
  const engine = audioEngine();

  const sendAll = () => {
    const s = useSettings.getState();
    engine.send({ type: "setNormalization", config: s.normalization });
    engine.send({ type: "setCrossfade", config: s.crossfade });
    engine.send({ type: "setDsp", config: s.dsp });
    engine.send({ type: "setOutput", config: s.output });
    void cacheApi.setLimit(s.cacheLimitGb * GIGABYTE).catch(() => {});
    void applyNetworkSpeakers(s.networkSpeakers);
  };

  const unsubscribeHydration = useSettings.persist.onFinishHydration(sendAll);
  if (useSettings.persist.hasHydrated()) sendAll();

  const unsubscribe = useSettings.subscribe((s, prev) => {
    if (s.normalization !== prev.normalization)
      engine.send({ type: "setNormalization", config: s.normalization });
    if (s.crossfade !== prev.crossfade) engine.send({ type: "setCrossfade", config: s.crossfade });
    if (s.dsp !== prev.dsp) engine.send({ type: "setDsp", config: s.dsp });
    if (s.output !== prev.output) engine.send({ type: "setOutput", config: s.output });
    if (s.cacheLimitGb !== prev.cacheLimitGb) {
      void cacheApi.setLimit(s.cacheLimitGb * GIGABYTE).catch(() => {});
    }
    if (s.networkSpeakers !== prev.networkSpeakers) void applyNetworkSpeakers(s.networkSpeakers);
  });

  return () => {
    unsubscribeHydration();
    unsubscribe();
  };
}

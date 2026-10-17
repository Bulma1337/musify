import { cacheApi } from "@/features/downloads/api";
import { GIGABYTE } from "@/features/downloads/types";
import { audioEngine } from "@/player/engine";
import { useSettings } from "./store";

/**
 * Keeps the audio engine configured from the settings store: DSP, normalization, crossfade and
 * output device. Sends everything once (after settings were loaded) and then only what changed.
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
  });

  return () => {
    unsubscribeHydration();
    unsubscribe();
  };
}

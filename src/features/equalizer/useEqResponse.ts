import { useEffect, useMemo, useState } from "react";
import { audioEngine } from "@/player/engine";
import type { BassEnhancerConfig, EqConfig, EqResponse } from "@/player/engineTypes";
import { computeEqResponse, EQ_SAMPLE_RATE } from "./eqMath";

const POINTS = 256;
const DEBOUNCE_MS = 40;

interface Input {
  eq: EqConfig;
  bass: BassEnhancerConfig | undefined;
}

/**
 * Frequency response of the EQ (and the bass enhancer's shelf, when given) for drawing. Shows the
 * TypeScript estimate immediately and replaces it with the engine's exact response at the device rate
 * (debounced, so dragging does not flood the engine; the browser preview has no engine and keeps the
 * estimate). The EQ is always computed as if it were on, so the curve stays visible while it is off.
 */
export function useEqResponse(eq: EqConfig, bass?: BassEnhancerConfig): EqResponse {
  const input = useMemo<Input>(() => ({ eq, bass }), [eq, bass]);
  const [native, setNative] = useState<{ input: Input; response: EqResponse } | null>(null);
  const local = useMemo(
    () => computeEqResponse({ ...input.eq, enabled: true }, POINTS, EQ_SAMPLE_RATE, input.bass),
    [input],
  );

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      audioEngine()
        .eqResponse({ ...input.eq, enabled: true }, POINTS, input.bass)
        .then((response) => {
          if (!cancelled && response) setNative({ input, response });
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input]);

  return native?.input === input ? native.response : local;
}

import { useEffect, useMemo, useState } from "react";
import { audioEngine } from "@/player/engine";
import type { EqConfig, EqResponse } from "@/player/engineTypes";
import { computeEqResponse } from "./eqMath";

const POINTS = 256;
const DEBOUNCE_MS = 40;

/**
 * Frequency response of the EQ for drawing. Shows the TypeScript estimate immediately and replaces it
 * with the engine's exact response (debounced, so dragging does not flood the engine; the browser
 * preview has no engine and keeps the estimate). The response is always computed as if the EQ were
 * on, so the curve stays visible while it is switched off.
 */
export function useEqResponse(eq: EqConfig): EqResponse {
  const [native, setNative] = useState<{ eq: EqConfig; response: EqResponse } | null>(null);
  const local = useMemo(() => computeEqResponse({ ...eq, enabled: true }, POINTS), [eq]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      audioEngine()
        .eqResponse({ ...eq, enabled: true }, POINTS)
        .then((response) => {
          if (!cancelled && response) setNative({ eq, response });
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [eq]);

  return native?.eq === eq ? native.response : local;
}

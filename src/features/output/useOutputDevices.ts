import { useEffect, useState } from "react";
import { audioEngine } from "@/player/engine";
import type { DeviceInfo } from "@/player/engineTypes";

/** Default device first, then by name. */
export function sortDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
  );
}

/**
 * Output devices from the engine (empty in the browser preview). Loads on mount; `refresh` loads again,
 * e.g. after plugging in a DAC.
 */
export function useOutputDevices() {
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<{ request: number; devices: DeviceInfo[]; failed: boolean } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    audioEngine()
      .devices()
      .then((devices) => {
        if (!cancelled) setResult({ request, devices: sortDevices(devices), failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ request, devices: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  return {
    devices: result?.devices ?? [],
    loading: result?.request !== request,
    failed: result?.failed ?? false,
    refresh: () => setRequest((n) => n + 1),
  };
}

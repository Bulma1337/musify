/** Requested pixel size for a displayed size (2× for HiDPI, bucketed so the browser cache hits). */
export function coverRequestSize(displaySize: number): number {
  const wanted = displaySize * Math.min(window.devicePixelRatio || 1, 2);
  return [64, 128, 300, 600, 1000].find((s) => s >= wanted) ?? 1000;
}

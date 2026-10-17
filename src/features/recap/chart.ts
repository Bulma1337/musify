export interface Point {
  x: number;
  y: number;
}

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * A smooth SVG path through all points (Catmull-Rom converted to cubic Beziers). The curve is
 * clamped between `minY` and `maxY` so overshoot never leaves the chart.
 */
export function smoothPath(points: Point[], minY = -Infinity, maxY = Infinity): string {
  if (points.length === 0) return "";
  const clamp = (y: number) => Math.min(maxY, Math.max(minY, y));
  let d = `M${r(points[0]!.x)} ${r(points[0]!.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    d += `C${r(p1.x + (p2.x - p0.x) / 6)} ${r(clamp(p1.y + (p2.y - p0.y) / 6))} ${r(p2.x - (p3.x - p1.x) / 6)} ${r(
      clamp(p2.y - (p3.y - p1.y) / 6),
    )} ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}

/** Chart points for a series: x spread evenly over `width`, y scaled so the maximum sits at `top`. */
export function seriesPoints(values: number[], width: number, height: number, top = 8): Point[] {
  const max = Math.max(...values, 1);
  return values.map((value, i) => ({
    x: values.length === 1 ? width / 2 : (i / (values.length - 1)) * width,
    y: height - (value / max) * (height - top),
  }));
}

import { seriesPoints, smoothPath } from "./chart";

describe("seriesPoints", () => {
  it("puts the maximum at the top margin and zero at the bottom", () => {
    const points = seriesPoints([0, 5, 10], 200, 100, 10);
    expect(points[0]).toEqual({ x: 0, y: 100 });
    expect(points[2]).toEqual({ x: 200, y: 10 });
    expect(points[1]!.y).toBe(55);
  });

  it("copes with a single value and all zeros", () => {
    expect(seriesPoints([3], 100, 50)[0]!.x).toBe(50);
    expect(seriesPoints([0, 0], 100, 50).every((p) => p.y === 50)).toBe(true);
  });
});

describe("smoothPath", () => {
  it("starts at the first point and ends at the last", () => {
    const d = smoothPath([
      { x: 0, y: 10 },
      { x: 10, y: 20 },
      { x: 20, y: 5 },
    ]);
    expect(d.startsWith("M0 10C")).toBe(true);
    expect(d.endsWith("20 5")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
  });

  it("keeps control points inside the clamp", () => {
    const d = smoothPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 100 },
        { x: 20, y: 0 },
      ],
      0,
      100,
    );
    const ys = [...d.matchAll(/C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)].flatMap((m) => [
      Number(m[2]),
      Number(m[4]),
    ]);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
  });

  it("returns an empty path without points", () => {
    expect(smoothPath([])).toBe("");
  });
});

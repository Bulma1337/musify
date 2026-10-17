import { pickClosest, signatureDistance } from "./coverMatch";

const solid = (v: number) => new Float32Array(768).fill(v);

describe("cover comparison", () => {
  it("measures how different two images are", () => {
    expect(signatureDistance(solid(0.5), solid(0.5))).toBe(0);
    expect(signatureDistance(solid(0), solid(1))).toBe(1);
    expect(signatureDistance(solid(0.2), solid(0.4))).toBeCloseTo(0.2);
  });

  it("keeps the search order when there is nothing to compare or nothing loads", async () => {
    const candidates = [
      { compareUrl: "a", displayUrl: "A" },
      { compareUrl: "b", displayUrl: "B" },
    ];
    expect(await pickClosest(null, candidates)).toBe(candidates[0]);
    expect(await pickClosest(solid(0.5), candidates, async () => null)).toBe(candidates[0]);
    expect(await pickClosest(solid(0.5), [])).toBeNull();
  });

  it("picks the closest image", async () => {
    const candidates = [
      { compareUrl: "dark", displayUrl: "DARK" },
      { compareUrl: "light", displayUrl: "LIGHT" },
    ];
    const load = async (url: string) => (url === "dark" ? solid(0.1) : solid(0.8));
    expect((await pickClosest(solid(0.75), candidates, load))?.displayUrl).toBe("LIGHT");
  });
});

import type { EqConfig, ParametricFilter } from "@/player/engineTypes";
import {
  biquadMagnitudeDb,
  computeEqResponse,
  designBiquad,
  GRAPHIC_FREQUENCIES,
  logFrequencies,
  resampleGraphicGains,
  solveGraphicFilters,
  type FilterSpec,
} from "./eqMath";

const FS = 48_000;
const db = (spec: FilterSpec, f: number) => biquadMagnitudeDb(designBiquad(spec, FS), f, FS);

describe("RBJ biquads", () => {
  it("peaking filter: gain at the center frequency equals the set gain, 0 dB far away", () => {
    const spec: FilterSpec = { kind: "peaking", freqHz: 1000, gainDb: 6, q: 1 };
    expect(db(spec, 1000)).toBeCloseTo(6, 6);
    expect(db(spec, 20)).toBeCloseTo(0, 1);
    expect(db(spec, 20_000)).toBeCloseTo(0, 1);
    expect(db({ ...spec, gainDb: -9 }, 1000)).toBeCloseTo(-9, 6);
  });

  it("matches the cookbook coefficients written in the textbook cos form", () => {
    const f0 = 1000;
    const G = 6;
    const Q = 1;
    const w0 = (2 * Math.PI * f0) / FS;
    const A = Math.pow(10, G / 40);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha / A;
    const expected = {
      b0: (1 + alpha * A) / a0,
      b1: (-2 * Math.cos(w0)) / a0,
      b2: (1 - alpha * A) / a0,
      a1: (-2 * Math.cos(w0)) / a0,
      a2: (1 - alpha / A) / a0,
    };
    const c = designBiquad({ kind: "peaking", freqHz: f0, gainDb: G, q: Q }, FS);
    for (const key of ["b0", "b1", "b2", "a1", "a2"] as const) expect(c[key]).toBeCloseTo(expected[key], 12);
  });

  it("shelves reach their full gain on the shelf side and half of it at the corner", () => {
    const low: FilterSpec = { kind: "lowShelf", freqHz: 200, gainDb: 8, q: Math.SQRT1_2 };
    expect(db(low, 200)).toBeCloseTo(4, 4);
    expect(db(low, 20)).toBeGreaterThan(7.7);
    expect(db(low, 15_000)).toBeCloseTo(0, 1);
    const high: FilterSpec = { kind: "highShelf", freqHz: 4000, gainDb: -6, q: Math.SQRT1_2 };
    expect(db(high, 4000)).toBeCloseTo(-3, 4);
    expect(db(high, 18_000)).toBeLessThan(-5);
    expect(db(high, 100)).toBeCloseTo(0, 2);
  });

  it("low and high pass are -3 dB at the corner (Butterworth) and follow the analog prototype", () => {
    const lp: FilterSpec = { kind: "lowPass", freqHz: 1000, gainDb: 0, q: Math.SQRT1_2 };
    expect(db(lp, 1000)).toBeCloseTo(-3.0103, 3);
    // Bilinear transform: |H|² = 1 / (1 + Ω⁴) with Ω = tan(πf/fs) / tan(πf0/fs).
    const omega = Math.tan((Math.PI * 2000) / FS) / Math.tan((Math.PI * 1000) / FS);
    expect(db(lp, 2000)).toBeCloseTo(-10 * Math.log10(1 + omega ** 4), 4);
    const hp: FilterSpec = { kind: "highPass", freqHz: 1000, gainDb: 0, q: Math.SQRT1_2 };
    expect(db(hp, 1000)).toBeCloseTo(-3.0103, 3);
    expect(db(hp, 10_000)).toBeCloseTo(0, 1);
    expect(db(hp, 50)).toBeLessThan(-50);
  });

  it("notch removes the center frequency and ignores the gain parameter", () => {
    const notch: FilterSpec = { kind: "notch", freqHz: 1000, gainDb: 12, q: 4 };
    expect(db(notch, 1000)).toBeLessThan(-100);
    expect(db(notch, 100)).toBeCloseTo(0, 1);
  });

  it("clamps out-of-range frequencies instead of producing NaN", () => {
    const c = designBiquad({ kind: "peaking", freqHz: 1e9, gainDb: 3, q: 0 }, FS);
    expect(Object.values(c).every(Number.isFinite)).toBe(true);
  });
});

describe("graphic EQ solver", () => {
  it("flat sliders give flat filters", () => {
    const filters = solveGraphicFilters("ten", new Array(10).fill(0), FS);
    expect(filters).toHaveLength(10);
    expect(filters.every((f) => f.gainDb === 0)).toBe(true);
  });

  it("makes the combined response hit every slider value at the band centers", () => {
    const gains = [6, 6, 6, 0, -4, -4, 0, 3, 6, 6];
    const eq: EqConfig = {
      enabled: true,
      preampDb: 0,
      autoHeadroom: false,
      mode: { type: "graphic", bands: "ten", gainsDb: gains },
    };
    const freqs = GRAPHIC_FREQUENCIES.ten.slice();
    // Evaluate exactly at the centers through a one-point-per-frequency response.
    const filters = solveGraphicFilters("ten", gains, FS).map((f) => designBiquad(f, FS));
    freqs.forEach((f, i) => {
      const total = filters.reduce((sum, c) => sum + biquadMagnitudeDb(c, f, FS), 0);
      expect(total).toBeCloseTo(gains[i] ?? 0, 3);
    });
    const response = computeEqResponse(eq, 64, FS);
    expect(Math.max(...response.magnitudeDb)).toBeLessThan(7.5);
  });

  it("works for the 31-band layout as well", () => {
    const gains = GRAPHIC_FREQUENCIES.thirtyOne.map((_, i) => (i % 2 === 0 ? 4 : -4));
    const filters = solveGraphicFilters("thirtyOne", gains, FS).map((f) => designBiquad(f, FS));
    GRAPHIC_FREQUENCIES.thirtyOne.forEach((f, i) => {
      const total = filters.reduce((sum, c) => sum + biquadMagnitudeDb(c, f, FS), 0);
      expect(total).toBeCloseTo(gains[i] ?? 0, 2);
    });
  });
});

describe("computeEqResponse", () => {
  const peak = (gainDb: number): ParametricFilter => ({
    enabled: true,
    kind: "peaking",
    freqHz: 1000,
    gainDb,
    q: 1,
  });

  it("is flat with a disabled EQ, whatever the preamp is", () => {
    const r = computeEqResponse(
      { enabled: false, preampDb: 5, autoHeadroom: true, mode: { type: "parametric", filters: [peak(9)] } },
      64,
    );
    expect(r.frequencies).toHaveLength(64);
    expect(r.magnitudeDb.every((v) => v === 0)).toBe(true);
    expect(r.effectivePreampDb).toBe(0);
    expect(r.maxBoostDb).toBe(0);
  });

  it("covers 20 Hz … 20 kHz on a log grid", () => {
    const f = logFrequencies(256);
    expect(f[0]).toBeCloseTo(20, 9);
    expect(f[255]).toBeCloseTo(20_000, 6);
    expect(f[128]! / f[127]!).toBeCloseTo(f[1]! / f[0]!, 9);
  });

  it("auto headroom lowers the preamp by the maximum boost so the peak lands at 0 dB", () => {
    const r = computeEqResponse(
      { enabled: true, preampDb: 0, autoHeadroom: true, mode: { type: "parametric", filters: [peak(6)] } },
      512,
    );
    expect(r.maxBoostDb).toBeCloseTo(6, 2);
    expect(r.effectivePreampDb).toBeCloseTo(-6, 2);
    expect(Math.max(...r.magnitudeDb)).toBeLessThan(0.05);
    expect(Math.max(...r.magnitudeDb)).toBeGreaterThan(-0.3);
  });

  it("adds the manual preamp and skips headroom when it is off", () => {
    const r = computeEqResponse(
      { enabled: true, preampDb: -3, autoHeadroom: false, mode: { type: "parametric", filters: [peak(6)] } },
      512,
    );
    expect(r.effectivePreampDb).toBe(-3);
    expect(Math.max(...r.magnitudeDb)).toBeCloseTo(3, 1);
  });

  it("does not boost for cuts only and ignores disabled filters", () => {
    const r = computeEqResponse(
      {
        enabled: true,
        preampDb: 0,
        autoHeadroom: true,
        mode: { type: "parametric", filters: [peak(-6), { ...peak(12), enabled: false }] },
      },
      256,
    );
    expect(r.effectivePreampDb).toBe(0);
    expect(Math.min(...r.magnitudeDb)).toBeCloseTo(-6, 0);
  });
});

describe("resampleGraphicGains", () => {
  it("keeps the ten octave values when going 10 → 31 → 10", () => {
    const ten = [4, 3, 1.5, 0, -2, -2, 0, 2, 5, 6];
    const back = resampleGraphicGains(resampleGraphicGains(ten, "ten", "thirtyOne"), "thirtyOne", "ten");
    expect(back).toEqual(ten);
  });

  it("interpolates between octave centers on log frequency and holds the edges", () => {
    const ten = [0, 0, 0, 0, 0, 10, 0, 0, 0, 0]; // +10 dB at 1 kHz only
    const thirty = resampleGraphicGains(ten, "ten", "thirtyOne");
    expect(thirty).toHaveLength(31);
    const at = (f: number) => thirty[GRAPHIC_FREQUENCIES.thirtyOne.indexOf(f)];
    expect(at(1000)).toBe(10);
    // 1.25 kHz is log2(1.25) ≈ 0.32 octave above 1 kHz → still 68 % of the way back to 0 dB.
    expect(at(1250)).toBeCloseTo(10 * (1 - Math.log2(1.25)), 1);
    expect(at(500)).toBe(0);
    // Edge hold: 20 Hz and 25 Hz take the 31.5 Hz value.
    const withBass = resampleGraphicGains([6, 0, 0, 0, 0, 0, 0, 0, 0, -6], "ten", "thirtyOne");
    expect(withBass[0]).toBe(6);
    expect(withBass[1]).toBe(6);
    expect(withBass[30]).toBe(-6);
  });

  it("returns a copy for the same layout", () => {
    const gains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const copy = resampleGraphicGains(gains, "ten", "ten");
    expect(copy).toEqual(gains);
    expect(copy).not.toBe(gains);
  });
});

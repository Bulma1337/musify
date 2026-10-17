import type { BassEnhancerConfig, EqConfig, ParametricFilter } from "@/player/engineTypes";
import golden from "./eqGolden.json";
import {
  analogPeakingMagSq,
  biquadMagnitudeDb,
  computeEqResponse,
  designBiquad,
  fitParametricToGraphic,
  GRAPHIC_FREQUENCIES,
  logFrequencies,
  matchedPeaking,
  resampleGraphicGains,
  solveGraphicFilters,
  type FilterSpec,
} from "./eqMath";
import { BUILT_IN_PRESETS } from "./presets";

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

describe("matched peaking filter", () => {
  // The analog prototype is matched exactly at DC, f0 and Nyquist (no bilinear squeeze of the upper skirt).
  // Between those points a bell close to Nyquist deviates by up to ~1 dB (16 kHz at 44.1 kHz); the graphic
  // solver fits the actual digital response, so that never reaches the curve the sliders describe.
  it("matches the analog prototype at f0 and Nyquist, and everywhere for bells well below Nyquist", () => {
    for (const fs of [44_100, 48_000, 96_000]) {
      for (const [f0, g, q] of [
        [16_000, 6, 1.9],
        [16_000, -12, 1.9],
        [1000, 9, 0.7],
        [60, -6, 3],
      ] as const) {
        const c = designBiquad({ kind: "peaking", freqHz: f0, gainDb: g, q, design: "matched" }, fs);
        const a = Math.pow(10, Math.abs(g) / 40);
        const analogDb = (f: number) =>
          10 * Math.log10(analogPeakingMagSq((f / f0) ** 2, a, q)) * Math.sign(g);
        expect(biquadMagnitudeDb(c, f0, fs)).toBeCloseTo(g, 6);
        expect(biquadMagnitudeDb(c, 0.5 * fs, fs)).toBeCloseTo(analogDb(0.5 * fs), 6);
        if (f0 <= 0.1 * fs) {
          for (let i = 0; i <= 100; i++) {
            const f = 20 * Math.pow((0.45 * fs) / 20, i / 100);
            expect(Math.abs(biquadMagnitudeDb(c, f, fs) - analogDb(f))).toBeLessThan(0.05);
          }
        }
      }
    }
  });

  it("cut is the exact inverse of the boost", () => {
    const boost = matchedPeaking(8000, 9, 1.5, 44_100);
    const cut = matchedPeaking(8000, -9, 1.5, 44_100);
    for (const f of [100, 4000, 8000, 15_000, 21_000]) {
      expect(biquadMagnitudeDb(boost, f, 44_100) + biquadMagnitudeDb(cut, f, 44_100)).toBeCloseTo(0, 9);
    }
  });
});

describe("graphic EQ solver", () => {
  const sumDb = (filters: FilterSpec[], f: number, fs: number) =>
    filters.reduce((sum, s) => sum + biquadMagnitudeDb(designBiquad(s, fs), f, fs), 0);
  /** Slider values interpolated on log frequency (the curve the sliders describe). */
  const target = (gains: readonly number[], f: number) => {
    const c = GRAPHIC_FREQUENCIES.ten.map(Math.log2);
    const x = Math.log2(f);
    let i = 0;
    while (i < c.length - 2 && (c[i + 1] ?? 0) < x) i++;
    const t = (x - (c[i] ?? 0)) / ((c[i + 1] ?? 1) - (c[i] ?? 0));
    return (gains[i] ?? 0) + t * ((gains[i + 1] ?? 0) - (gains[i] ?? 0));
  };

  it("flat sliders give flat filters (centers and midpoints)", () => {
    const filters = solveGraphicFilters("ten", new Array(10).fill(0), FS);
    expect(filters).toHaveLength(19);
    expect(filters.every((f) => f.gainDb === 0 && f.design === "matched")).toBe(true);
  });

  it("follows the slider curve within 0.6 dB, also near Nyquist at 44.1 kHz", () => {
    for (const fs of [44_100, 48_000, 96_000]) {
      for (const gains of [
        [5, 4, 2.5, 1, -1, -1.5, 0.5, 2.5, 3.5, 4],
        new Array(10).fill(12),
        [0, 0, 0, 0, 0, 1, 2.5, 4, 5.5, 6],
      ]) {
        const filters = solveGraphicFilters("ten", gains, fs);
        for (let i = 0; i <= 200; i++) {
          const f = 31.5 * Math.pow(16_000 / 31.5, i / 200);
          expect(Math.abs(sumDb(filters, f, fs) - target(gains, f))).toBeLessThan(0.6);
        }
        GRAPHIC_FREQUENCIES.ten.forEach((f, i) => {
          expect(Math.abs(sumDb(filters, f, fs) - (gains[i] ?? 0))).toBeLessThan(0.15);
        });
      }
    }
  });

  it("works for the 31-band layout as well", () => {
    const gains = GRAPHIC_FREQUENCIES.thirtyOne.map((_, i) => (i % 2 === 0 ? 4 : -4));
    const filters = solveGraphicFilters("thirtyOne", gains, FS);
    expect(filters).toHaveLength(61);
    GRAPHIC_FREQUENCIES.thirtyOne.forEach((f, i) => {
      expect(Math.abs(sumDb(filters, f, FS) - (gains[i] ?? 0))).toBeLessThan(0.2);
    });
  });

  it("fits one ordinary peaking filter per band for the parametric mode", () => {
    const gains = [5, 4, 2.5, 1, -1, -1.5, 0.5, 2.5, 3.5, 4];
    const filters = fitParametricToGraphic("ten", gains, FS);
    expect(filters).toHaveLength(10);
    expect(filters.every((f) => f.design === undefined)).toBe(true);
    GRAPHIC_FREQUENCIES.ten.slice(0, 9).forEach((f, i) => {
      expect(Math.abs(sumDb(filters, f, FS) - (gains[i] ?? 0))).toBeLessThan(1);
    });
  });
});

describe("golden fixture (shared with the Rust engine)", () => {
  it("built-in presets match the ones the engine tests use", () => {
    expect(golden.presets.map((p) => [p.id, p.gainsDb])).toEqual(
      BUILT_IN_PRESETS.map((p) => [p.id, p.gainsDb]),
    );
  });

  for (const c of golden.cases) {
    it(`reproduces "${c.name}"`, () => {
      const eq = c.config.eq as EqConfig;
      if (eq.mode.type !== "graphic") throw new Error("graphic cases only");
      const filters = solveGraphicFilters(eq.mode.bands, eq.mode.gainsDb, c.sampleRate);
      expect(filters).toHaveLength(c.filters.length);
      filters.forEach((f, i) => {
        const g = c.filters[i]!;
        expect(f.freqHz).toBeCloseTo(g.freqHz, 9);
        expect(f.q).toBeCloseTo(g.q, 9);
        // Ill-conditioned settings (zig-zag) converge to the same optimum within a few 1e-6 dB.
        expect(Math.abs(f.gainDb - g.gainDb)).toBeLessThan(1e-5);
      });
      const r = computeEqResponse(eq, c.points, c.sampleRate, c.config.bass as BassEnhancerConfig);
      r.magnitudeDb.forEach((v, i) => expect(Math.abs(v - c.magnitudeDb[i]!)).toBeLessThan(1e-5));
      expect(Math.abs(r.maxBoostDb - c.maxBoostDb)).toBeLessThan(1e-5);
      expect(Math.abs(r.effectivePreampDb - c.effectivePreampDb)).toBeLessThan(1e-5);
    });
  }
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

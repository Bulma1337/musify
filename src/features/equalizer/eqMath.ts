import type {
  BassEnhancerConfig,
  EqConfig,
  EqResponse,
  FilterKind,
  GraphicBands,
  ParametricFilter,
} from "@/player/engineTypes";

/**
 * Frequency response of an EQ configuration, computed in TypeScript.
 *
 * The native engine is the source of truth (`audioEngine().eqResponse`). This is the fallback for the
 * browser preview and mirrors the Rust implementation (`dsp/biquad.rs`, `dsp/eq/graphic.rs`,
 * `dsp/eq/mod.rs`): RBJ Audio-EQ-Cookbook filters for parametric bands, magnitude-matched peaking
 * filters fitted by least squares for the graphic EQ, the bass enhancer's shelf and the auto-headroom
 * preamp. `eqGolden.json` (written by the Rust tests) keeps both implementations in sync.
 */

export const EQ_SAMPLE_RATE = 48_000;
export const F_MIN = 20;
export const F_MAX = 20_000;
export const MAX_PARAMETRIC_FILTERS = 16;
/** Graphic sliders are limited to this on the page (the engine accepts ±24 dB). */
export const SLIDER_RANGE_DB = 12;

export const GRAPHIC_FREQUENCIES: Record<GraphicBands, readonly number[]> = {
  ten: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  thirtyOne: [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
    2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
  ],
};

const BUTTERWORTH_Q = Math.SQRT1_2;
const MAX_FREQ_RATIO = 0.49;
const MIN_FREQ_HZ = 2;
const MIN_Q = 0.025;
const MAX_Q = 100;
const MAX_FILTER_GAIN_DB = 48;
const MAX_SLIDER_DB = 24;
const MAX_SOLVED_GAIN_DB = 36;
const MAX_PREAMP_DB = 30;
const HEADROOM_POINTS = 512;

/** How the analog prototype becomes a biquad (see `dsp/biquad.rs`). */
export type FilterDesign = "bilinear" | "matched";

export interface FilterSpec {
  kind: FilterKind;
  freqHz: number;
  gainDb: number;
  q: number;
  /** "bilinear" (RBJ, default) or "matched" (warping-free, peaking only; used by the graphic EQ). */
  design?: FilterDesign;
}

/** Normalized biquad coefficients (a0 = 1). */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function hasGain(kind: FilterKind): boolean {
  return kind === "peaking" || kind === "lowShelf" || kind === "highShelf";
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function clampSpec(spec: FilterSpec, fs: number): FilterSpec {
  const maxF = Math.max(MAX_FREQ_RATIO * fs, MIN_FREQ_HZ);
  return {
    kind: spec.kind,
    freqHz: Number.isFinite(spec.freqHz) ? clamp(spec.freqHz, MIN_FREQ_HZ, maxF) : Math.min(1000, maxF),
    gainDb:
      hasGain(spec.kind) && Number.isFinite(spec.gainDb)
        ? clamp(spec.gainDb, -MAX_FILTER_GAIN_DB, MAX_FILTER_GAIN_DB)
        : 0,
    q: Number.isFinite(spec.q) && spec.q > 0 ? clamp(spec.q, MIN_Q, MAX_Q) : BUTTERWORTH_Q,
    design: spec.design ?? "bilinear",
  };
}

const validRate = (fs: number) => (Number.isFinite(fs) && fs > 0 ? fs : EQ_SAMPLE_RATE);

/**
 * Biquad for `input`: RBJ cookbook (shelves in Q form, like AutoEQ profiles), or the matched peaking
 * design when `design` is "matched". Parameters are clamped.
 */
export function designBiquad(input: FilterSpec, sampleRate: number = EQ_SAMPLE_RATE): Biquad {
  const fs = validRate(sampleRate);
  if (input.design === "matched" && input.kind === "peaking") {
    return matchedPeaking(input.freqHz, input.gainDb, input.q, fs);
  }
  const s = clampSpec(input, fs);
  const w0 = (2 * Math.PI * s.freqHz) / fs;
  const sinW = Math.sin(w0);
  const half = Math.sin(0.5 * w0);
  const omc = 2 * half * half; // 1 - cos(w0), accurate for small w0
  const cosW = 1 - omc;
  const alpha = sinW / (2 * s.q);
  const a = Math.pow(10, s.gainDb / 40);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (s.kind) {
    case "peaking":
      b0 = 1 + alpha * a;
      b1 = -2 * cosW;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cosW;
      a2 = 1 - alpha / a;
      break;
    case "lowShelf": {
      const sq = 2 * Math.sqrt(a) * alpha;
      b0 = a * (2 + (a - 1) * omc + sq);
      b1 = 2 * a * (-2 + (a + 1) * omc);
      b2 = a * (2 + (a - 1) * omc - sq);
      a0 = 2 * a - (a - 1) * omc + sq;
      a1 = -2 * (2 * a - (a + 1) * omc);
      a2 = 2 * a - (a - 1) * omc - sq;
      break;
    }
    case "highShelf": {
      const sq = 2 * Math.sqrt(a) * alpha;
      b0 = a * (2 * a - (a - 1) * omc + sq);
      b1 = -2 * a * (2 * a - (a + 1) * omc);
      b2 = a * (2 * a - (a - 1) * omc - sq);
      a0 = 2 + (a - 1) * omc + sq;
      a1 = 2 * (-2 + (a + 1) * omc);
      a2 = 2 + (a - 1) * omc - sq;
      break;
    }
    case "lowPass":
      b0 = 0.5 * omc;
      b1 = omc;
      b2 = 0.5 * omc;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    case "highPass": {
      const opc = 2 - omc; // 1 + cos(w0)
      b0 = 0.5 * opc;
      b1 = -opc;
      b2 = 0.5 * opc;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    }
    case "notch":
      b0 = 1;
      b1 = -2 * cosW;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
  }
  const inv = 1 / a0;
  return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv };
}

/** `|H(jΩ)|²` of the analog peaking prototype at `Ω² = omegaSq` (frequency normalized to f0), `a = 10^(gain/40)`. */
export function analogPeakingMagSq(omegaSq: number, a: number, q: number): number {
  const re = (1 - omegaSq) * (1 - omegaSq);
  return (re + omegaSq * (a / q) * (a / q)) / (re + omegaSq / (a * q * (a * q)));
}

/** Minimum-phase `(b0, b1, b2)` with `|B|² = dc·cos²(w/2) + ny·sin²(w/2) + x·cos²(w/2)·sin²(w/2)`. */
function factorMagnitude(dc: number, ny: number, x: number): [number, number, number] {
  const p = Math.sqrt(Math.max(dc, 0));
  const m = Math.sqrt(Math.max(ny, 0));
  const w = 0.5 * (p + m);
  const d = Math.sqrt(Math.max(w * w + 0.25 * x, 0));
  return [0.5 * (w + d), 0.5 * (p - m), 0.5 * (w - d)];
}

/**
 * Magnitude-matched peaking filter (M. Vicanek, "Matched Second Order Digital Filters", 2016):
 * impulse-invariant poles, numerator matched to the analog prototype at DC, f0 and Nyquist, so the bell
 * keeps its width up to Nyquist. A cut is the exact inverse of the matching boost.
 */
export function matchedPeaking(freqHz: number, gainDb: number, q: number, sampleRate: number): Biquad {
  const fs = validRate(sampleRate);
  const s = clampSpec({ kind: "peaking", freqHz, gainDb, q }, fs);
  const w0 = (2 * Math.PI * s.freqHz) / fs;
  const a = Math.pow(10, Math.abs(s.gainDb) / 40);
  const zeta = 1 / (2 * a * s.q);
  const r = Math.exp(-zeta * w0);
  const a1 =
    zeta <= 1
      ? -2 * r * Math.cos(w0 * Math.sqrt(1 - zeta * zeta))
      : -2 * r * Math.cosh(w0 * Math.sqrt(zeta * zeta - 1));
  const a2 = r * r;
  if (s.gainDb === 0) return { b0: 1, b1: a1, b2: a2, a1, a2 };
  const denDc = (1 + a1 + a2) * (1 + a1 + a2);
  const denNy = (1 - a1 + a2) * (1 - a1 + a2);
  const denX = -16 * a2;
  const half = Math.sin(0.5 * w0);
  const phi1 = half * half;
  const phi0 = 1 - phi1;
  const g2 = a * a * a * a;
  const omegaNy = (0.5 * fs) / s.freqHz;
  const ny2 = analogPeakingMagSq(omegaNy * omegaNy, a, s.q);
  const numDc = denDc;
  const numNy = denNy * ny2;
  const numX = ((g2 - 1) * denDc) / phi1 + ((g2 - ny2) * denNy) / phi0 + g2 * denX;
  const [b0, b1, b2] = factorMagnitude(numDc, numNy, numX);
  if (s.gainDb > 0) return { b0, b1, b2, a1, a2 };
  const inv = 1 / b0;
  return { b0: inv, b1: a1 * inv, b2: a2 * inv, a1: b1 * inv, a2: b2 * inv };
}

/** `φ = sin²(π·f/fs)`, the frequency variable of {@link magnitudeSqPhi}. */
export function phiOf(freqHz: number, fs: number): number {
  const s = Math.sin((Math.PI * freqHz) / fs);
  return s * s;
}

/** Squared magnitude of a biquad at `φ = sin²(w/2)` (numerically robust cookbook form). */
export function magnitudeSqPhi(c: Biquad, phi: number): number {
  const { b0, b1, b2, a1, a2 } = c;
  const bs = b0 + b1 + b2;
  const as = 1 + a1 + a2;
  const num = bs * bs - 4 * (b0 * b1 + 4 * b0 * b2 + b1 * b2) * phi + 16 * b0 * b2 * phi * phi;
  const den = as * as - 4 * (a1 + 4 * a2 + a1 * a2) * phi + 16 * a2 * phi * phi;
  return Math.max(num, 1e-300) / Math.max(den, 1e-300);
}

/** Magnitude of a biquad at `freqHz` in dB. */
export function biquadMagnitudeDb(c: Biquad, freqHz: number, fs: number = EQ_SAMPLE_RATE): number {
  return 10 * Math.log10(magnitudeSqPhi(c, phiOf(freqHz, fs)));
}

/** `points` log-spaced frequencies from 20 Hz to 20 kHz. */
export function logFrequencies(points: number): number[] {
  if (points <= 0) return [];
  if (points === 1) return [F_MIN];
  const r = Math.log(F_MAX / F_MIN);
  return Array.from({ length: points }, (_, i) => F_MIN * Math.exp((r * i) / (points - 1)));
}

// --- Graphic EQ (mirror of `dsp/eq/graphic.rs`) ---------------------------------------------------
//
// Target: slider values interpolated linearly on log frequency between the band centers. Filters: a
// matched peaking filter at every center and at every geometric midpoint (2·n − 1 filters), Q =
// Q_SCALE / local spacing in octaves, the outermost two × EDGE_Q_FACTOR. Gains: Levenberg–Marquardt
// on the weighted dB error at the centers and POINTS_PER_INTERVAL points per interval.

export const GRAPHIC_Q_SCALE = 0.95;
const EDGE_Q_FACTOR = 1.25;
const POINTS_PER_INTERVAL = 4;
const CENTER_WEIGHT = 2;
const MAX_ITERATIONS = 30;
const MAX_DAMPING_TRIES = 8;
const STEP_TOLERANCE_DB = 1e-6;
const JACOBIAN_STEP_DB = 1e-3;
const LAMBDA_START = 1e-3;
const LAMBDA_MIN = 1e-9;
const RIDGE = 1e-12;

interface FitPoint {
  freqHz: number;
  targetDb: number;
  weight: number;
}

/** Band centers usable at `fs` (≤ 0.49·fs) and their clamped slider values. */
function usableBands(bands: GraphicBands, gainsDb: readonly number[], fs: number): [number[], number[]] {
  const centers: number[] = [];
  const targets: number[] = [];
  GRAPHIC_FREQUENCIES[bands].forEach((f, i) => {
    if (f > MAX_FREQ_RATIO * fs) return;
    const s = gainsDb[i];
    centers.push(f);
    targets.push(clamp(s !== undefined && Number.isFinite(s) ? s : 0, -MAX_SLIDER_DB, MAX_SLIDER_DB));
  });
  return [centers, targets];
}

/** `[frequency, Q]` of every filter: centers plus midpoints (`withMidpoints`), or the centers only. */
function filterLayout(centers: readonly number[], withMidpoints = true): [number, number][] {
  const freqs: number[] = [];
  centers.forEach((c, i) => {
    freqs.push(c);
    const next = centers[i + 1];
    if (withMidpoints && next !== undefined) freqs.push(Math.sqrt(c * next));
  });
  const last = freqs.length - 1;
  return freqs.map((f, k) => {
    const left = k > 0 ? Math.log2(f / (freqs[k - 1] ?? f)) : undefined;
    const right = k < last ? Math.log2((freqs[k + 1] ?? f) / f) : undefined;
    const spacing = left !== undefined && right !== undefined ? 0.5 * (left + right) : (left ?? right ?? 0.5);
    const edge = last > 0 && (k === 0 || k === last) ? EDGE_Q_FACTOR : 1;
    return [f, (edge * GRAPHIC_Q_SCALE) / spacing];
  });
}

function fitPoints(centers: readonly number[], targets: readonly number[]): FitPoint[] {
  const points: FitPoint[] = [];
  centers.forEach((f, i) => {
    const t = targets[i] ?? 0;
    points.push({ freqHz: f, targetDb: t, weight: CENTER_WEIGHT });
    const f1 = centers[i + 1];
    const t1 = targets[i + 1];
    if (f1 === undefined || t1 === undefined) return;
    for (let j = 1; j <= POINTS_PER_INTERVAL; j++) {
      const u = j / (POINTS_PER_INTERVAL + 1);
      points.push({ freqHz: f * Math.pow(f1 / f, u), targetDb: t + u * (t1 - t), weight: 1 });
    }
  });
  return points;
}

type Designer = (f: number, g: number, q: number, fs: number) => Biquad;
const matchedDesigner: Designer = (f, g, q, fs) => matchedPeaking(f, g, q, fs);
const bilinearDesigner: Designer = (f, g, q, fs) =>
  designBiquad({ kind: "peaking", freqHz: f, gainDb: g, q }, fs);

const dbSq = (x: number) => 10 * Math.log10(x);

function responses(
  layout: readonly [number, number][],
  gains: readonly number[],
  phis: readonly number[],
  fs: number,
  design: Designer,
  out: number[],
) {
  out.fill(0);
  layout.forEach(([f, q], k) => {
    const g = gains[k] ?? 0;
    if (g === 0) return;
    const c = design(f, g, q, fs);
    for (let j = 0; j < phis.length; j++) out[j] = (out[j] ?? 0) + dbSq(magnitudeSqPhi(c, phis[j] ?? 0));
  });
}

function cost(points: readonly FitPoint[], resp: readonly number[]): number {
  let sum = 0;
  points.forEach((p, j) => {
    const e = p.weight * (p.targetDb - (resp[j] ?? 0));
    sum += e * e;
  });
  return sum;
}

/** Solves `A x = b` (row-major n×n) by Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(a: number[], b: number[], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r * n + col] ?? 0) > Math.abs(a[piv * n + col] ?? 0)) piv = r;
    }
    if (Math.abs(a[piv * n + col] ?? 0) < 1e-300) return null;
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[piv * n + k] ?? 0;
        a[piv * n + k] = a[col * n + k] ?? 0;
        a[col * n + k] = t;
      }
      const t = b[piv] ?? 0;
      b[piv] = b[col] ?? 0;
      b[col] = t;
    }
    const d = a[col * n + col] ?? 1;
    for (let row = col + 1; row < n; row++) {
      const f = (a[row * n + col] ?? 0) / d;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k] = (a[row * n + k] ?? 0) - f * (a[col * n + k] ?? 0);
      b[row] = (b[row] ?? 0) - f * (b[col] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row] ?? 0;
    for (let k = row + 1; k < n; k++) sum -= (a[row * n + k] ?? 0) * (x[k] ?? 0);
    x[row] = sum / (a[row * n + row] ?? 1);
  }
  return x;
}

/** Levenberg–Marquardt for `min_g Σ_j w_j² (t_j − Σ_k H_k(f_j; g_k))²`. */
function solveGains(
  layout: readonly [number, number][],
  points: readonly FitPoint[],
  fs: number,
  design: Designer,
): number[] {
  const n = layout.length;
  const m = points.length;
  const phis = points.map((p) => phiOf(p.freqHz, fs));
  const g = new Array<number>(n).fill(0);
  const resp = new Array<number>(m).fill(0);
  responses(layout, g, phis, fs, design, resp);
  let current = cost(points, resp);
  const jac = new Array<number>(n * m).fill(0);
  const wr = new Array<number>(m).fill(0);
  const jtj = new Array<number>(n * n).fill(0);
  const jtr = new Array<number>(n).fill(0);
  const trial = new Array<number>(n).fill(0);
  const trialResp = new Array<number>(m).fill(0);
  let lambda = LAMBDA_START;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    layout.forEach(([f, q], k) => {
      const gk = g[k] ?? 0;
      const c0 = design(f, gk, q, fs);
      const c1 = design(f, gk + JACOBIAN_STEP_DB, q, fs);
      for (let j = 0; j < m; j++) {
        const p = phis[j] ?? 0;
        const ratio = magnitudeSqPhi(c1, p) / magnitudeSqPhi(c0, p);
        jac[k * m + j] = ((points[j]?.weight ?? 1) * dbSq(ratio)) / JACOBIAN_STEP_DB;
      }
    });
    for (let j = 0; j < m; j++)
      wr[j] = (points[j]?.weight ?? 1) * ((points[j]?.targetDb ?? 0) - (resp[j] ?? 0));
    for (let a = 0; a < n; a++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += (jac[a * m + j] ?? 0) * (wr[j] ?? 0);
      jtr[a] = s;
      for (let b = a; b < n; b++) {
        let v = 0;
        for (let j = 0; j < m; j++) v += (jac[a * m + j] ?? 0) * (jac[b * m + j] ?? 0);
        jtj[a * n + b] = v;
        jtj[b * n + a] = v;
      }
    }
    let step: number | null = null;
    for (let tries = 0; tries < MAX_DAMPING_TRIES; tries++) {
      const lhs = jtj.slice();
      for (let i = 0; i < n; i++)
        lhs[i * n + i] = (lhs[i * n + i] ?? 0) + lambda * (jtj[i * n + i] ?? 0) + RIDGE;
      const delta = solveLinear(lhs, jtr.slice(), n);
      if (!delta) break;
      for (let k = 0; k < n; k++) {
        trial[k] = clamp((g[k] ?? 0) + (delta[k] ?? 0), -MAX_SOLVED_GAIN_DB, MAX_SOLVED_GAIN_DB);
      }
      responses(layout, trial, phis, fs, design, trialResp);
      const c = cost(points, trialResp);
      if (c <= current) {
        let maxStep = 0;
        for (let k = 0; k < n; k++) maxStep = Math.max(maxStep, Math.abs((trial[k] ?? 0) - (g[k] ?? 0)));
        for (let k = 0; k < n; k++) g[k] = trial[k] ?? 0;
        for (let j = 0; j < m; j++) resp[j] = trialResp[j] ?? 0;
        current = c;
        lambda = Math.max(lambda * 0.1, LAMBDA_MIN);
        step = maxStep;
        break;
      }
      lambda *= 10;
    }
    if (step === null || step < STEP_TOLERANCE_DB) break;
  }
  return g;
}

/**
 * Filters that make the summed response follow the slider curve (matched peaking, centers and
 * midpoints). Bands above 0.49·fs are left out; missing slider values count as 0 dB.
 */
export function solveGraphicFilters(
  bands: GraphicBands,
  gainsDb: readonly number[],
  fs: number = EQ_SAMPLE_RATE,
): FilterSpec[] {
  const [centers, targets] = usableBands(bands, gainsDb, validRate(fs));
  const layout = filterLayout(centers);
  const gains = targets.every((t) => t === 0)
    ? new Array<number>(layout.length).fill(0)
    : solveGains(layout, fitPoints(centers, targets), validRate(fs), matchedDesigner);
  return layout.map(([freqHz, q], k) => ({
    kind: "peaking",
    freqHz,
    gainDb: gains[k] ?? 0,
    q,
    design: "matched",
  }));
}

/**
 * Ordinary (RBJ) peaking filters, one per band center, fitted to the same slider curve: what a
 * parametric EQ needs to sound like the graphic setting (used when switching to parametric mode).
 */
export function fitParametricToGraphic(
  bands: GraphicBands,
  gainsDb: readonly number[],
  fs: number = EQ_SAMPLE_RATE,
): FilterSpec[] {
  const [centers, targets] = usableBands(bands, gainsDb, validRate(fs));
  const layout = filterLayout(centers, false);
  const gains = targets.every((t) => t === 0)
    ? new Array<number>(layout.length).fill(0)
    : solveGains(layout, fitPoints(centers, targets), validRate(fs), bilinearDesigner);
  return layout.map(([freqHz, q], k) => ({ kind: "peaking", freqHz, gainDb: gains[k] ?? 0, q }));
}

export const toSpec = (f: ParametricFilter): FilterSpec => ({
  kind: f.kind,
  freqHz: f.freqHz,
  gainDb: f.gainDb,
  q: f.q,
});

/** The filters the engine runs for `eq` (empty while the EQ is off). */
export function eqFilterSpecs(eq: EqConfig, fs: number = EQ_SAMPLE_RATE): FilterSpec[] {
  if (!eq.enabled) return [];
  if (eq.mode.type === "graphic") return solveGraphicFilters(eq.mode.bands, eq.mode.gainsDb, fs);
  return eq.mode.filters.filter((f) => f.enabled).map((f) => clampSpec(toSpec(f), fs));
}

function totalDb(coeffs: Biquad[], f: number, fs: number): number {
  let sum = 0;
  for (const c of coeffs) sum += biquadMagnitudeDb(c, f, fs);
  return sum;
}

/** Highest point of the combined response: log grid, every filter frequency, golden-section refinement. */
function maxBoostDb(coeffs: Biquad[], specs: FilterSpec[], fs: number): number {
  const grid = logFrequencies(HEADROOM_POINTS).filter((f) => f < 0.5 * fs);
  if (grid.length === 0) return 0;
  let best = -Infinity;
  let bestIndex = 0;
  grid.forEach((f, i) => {
    const v = totalDb(coeffs, f, fs);
    if (v > best) {
      best = v;
      bestIndex = i;
    }
  });
  for (const s of specs) {
    if (s.freqHz >= F_MIN && s.freqHz <= F_MAX && s.freqHz < 0.5 * fs) {
      best = Math.max(best, totalDb(coeffs, s.freqHz, fs));
    }
  }
  const evalAt = (x: number) => totalDb(coeffs, Math.exp(x), fs);
  let lo = Math.log(grid[Math.max(bestIndex - 1, 0)] ?? F_MIN);
  let hi = Math.min(Math.log(grid[Math.min(bestIndex + 1, grid.length - 1)] ?? F_MAX), Math.log(0.499 * fs));
  if (hi > lo) {
    const gr = 0.6180339887498949;
    let c = hi - gr * (hi - lo);
    let d = lo + gr * (hi - lo);
    let fc = evalAt(c);
    let fd = evalAt(d);
    for (let i = 0; i < 48; i++) {
      if (fc > fd) {
        hi = d;
        d = c;
        fd = fc;
        c = hi - gr * (hi - lo);
        fc = evalAt(c);
      } else {
        lo = c;
        c = d;
        fc = fd;
        d = lo + gr * (hi - lo);
        fd = evalAt(d);
      }
    }
    best = Math.max(best, fc, fd);
  }
  return best;
}

const BASS_FREQ_RANGE: [number, number] = [20, 300];
const BASS_MAX_BOOST_DB = 24;

/** The bass enhancer's low shelf (its harmonics are nonlinear and not part of any response). */
export function bassShelfSpec(bass: BassEnhancerConfig): FilterSpec {
  const freq = Number.isFinite(bass.frequencyHz) ? bass.frequencyHz : 80;
  const boost = bass.enabled && Number.isFinite(bass.boostDb) ? clamp(bass.boostDb, 0, BASS_MAX_BOOST_DB) : 0;
  return {
    kind: "lowShelf",
    freqHz: clamp(freq, BASS_FREQ_RANGE[0], BASS_FREQ_RANGE[1]),
    gainDb: boost,
    q: BUTTERWORTH_Q,
  };
}

/**
 * Response of `eq` (plus the bass enhancer's shelf when `bass` is enabled) at `points` log-spaced
 * frequencies, including the effective preamp (manual preamp minus auto headroom), like the engine's
 * `audio_eq_response`.
 */
export function computeEqResponse(
  eq: EqConfig,
  points: number,
  fs: number = EQ_SAMPLE_RATE,
  bass?: BassEnhancerConfig,
): EqResponse {
  fs = validRate(fs);
  const specs = eqFilterSpecs(eq, fs);
  const shelf = bass?.enabled ? [clampSpec(bassShelfSpec(bass), fs)] : [];
  const coeffs = [...specs, ...shelf].map((s) => designBiquad(s, fs));
  const maxBoost = coeffs.length > 0 ? maxBoostDb(coeffs, specs, fs) : 0;
  const manual =
    eq.enabled && Number.isFinite(eq.preampDb) ? clamp(eq.preampDb, -MAX_PREAMP_DB, MAX_PREAMP_DB) : 0;
  const headroom = eq.autoHeadroom ? Math.max(maxBoost, 0) : 0;
  const preamp = manual - headroom;
  const frequencies = logFrequencies(points);
  return {
    frequencies,
    magnitudeDb: frequencies.map((f) => preamp + totalDb(coeffs, f, fs)),
    maxBoostDb: maxBoost,
    effectivePreampDb: preamp,
  };
}

/**
 * Converts slider values between the 10- and 31-band layouts by interpolating on log frequency.
 * Outside the source range the edge value is held. Values are rounded to 0.1 dB.
 */
export function resampleGraphicGains(
  gainsDb: readonly number[],
  from: GraphicBands,
  to: GraphicBands,
): number[] {
  if (from === to) return gainsDb.slice();
  const src = GRAPHIC_FREQUENCIES[from].map((f) => Math.log2(f));
  const values = src.map((_, i) => gainsDb[i] ?? 0);
  return GRAPHIC_FREQUENCIES[to].map((f) => {
    const x = Math.log2(f);
    const first = src[0] ?? 0;
    const last = src[src.length - 1] ?? 0;
    let v: number;
    if (x <= first) v = values[0] ?? 0;
    else if (x >= last) v = values[values.length - 1] ?? 0;
    else {
      let i = 0;
      while (i < src.length - 2 && (src[i + 1] ?? 0) < x) i++;
      const x0 = src[i] ?? 0;
      const x1 = src[i + 1] ?? 0;
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      v = (values[i] ?? 0) + t * ((values[i + 1] ?? 0) - (values[i] ?? 0));
    }
    return Math.round(v * 10) / 10;
  });
}

import type { EqConfig, EqResponse, FilterKind, GraphicBands, ParametricFilter } from "@/player/engineTypes";

/**
 * Frequency response of an EQ configuration, computed in TypeScript.
 *
 * The native engine is the source of truth (`audioEngine().eqResponse`). This is the fallback for the
 * browser preview and mirrors the Rust implementation (`dsp/biquad.rs`, `dsp/eq/graphic.rs`): RBJ
 * Audio-EQ-Cookbook filters, the constant-Q graphic EQ with band-interaction correction (Newton
 * iteration) and the auto-headroom preamp.
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

const Q_OCTAVE = 1.41;
const Q_THIRD_OCTAVE = 4.32;
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

export interface FilterSpec {
  kind: FilterKind;
  freqHz: number;
  gainDb: number;
  q: number;
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
  };
}

/** RBJ cookbook biquad (shelves in Q form, like AutoEQ profiles). Parameters are clamped. */
export function designBiquad(input: FilterSpec, fs: number = EQ_SAMPLE_RATE): Biquad {
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

/** Magnitude of a biquad at `freqHz` in dB (numerically robust sin²(w/2) form). */
export function biquadMagnitudeDb(c: Biquad, freqHz: number, fs: number = EQ_SAMPLE_RATE): number {
  const sine = Math.sin((Math.PI * freqHz) / fs);
  const phi = sine * sine;
  const { b0, b1, b2, a1, a2 } = c;
  const bs = b0 + b1 + b2;
  const as = 1 + a1 + a2;
  const num = bs * bs - 4 * (b0 * b1 + 4 * b0 * b2 + b1 * b2) * phi + 16 * b0 * b2 * phi * phi;
  const den = as * as - 4 * (a1 + 4 * a2 + a1 * a2) * phi + 16 * a2 * phi * phi;
  return 10 * Math.log10(Math.max(num, 1e-300) / Math.max(den, 1e-300));
}

/** `points` log-spaced frequencies from 20 Hz to 20 kHz. */
export function logFrequencies(points: number): number[] {
  if (points <= 0) return [];
  if (points === 1) return [F_MIN];
  const r = Math.log(F_MAX / F_MIN);
  return Array.from({ length: points }, (_, i) => F_MIN * Math.exp((r * i) / (points - 1)));
}

export function graphicQ(bands: GraphicBands): number {
  return bands === "ten" ? Q_OCTAVE : Q_THIRD_OCTAVE;
}

/** Solves `A x = b` (row-major n×n) by Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(a: number[], b: number[], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r * n + col] ?? 0) > Math.abs(a[piv * n + col] ?? 0)) piv = r;
    }
    if (Math.abs(a[piv * n + col] ?? 0) < 1e-12) return null;
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

const peaking = (f: number, g: number, q: number, fs: number) =>
  designBiquad({ kind: "peaking", freqHz: f, gainDb: g, q }, fs);

/** Newton iteration for `Σ_k H_k(f_j; g_k) = s_j` (neighbouring bands overlap, so raw slider values overshoot). */
function solveGains(freqs: number[], targets: number[], q: number, fs: number): number[] {
  const n = freqs.length;
  const g = targets.slice();
  if (targets.every((t) => t === 0)) return g;
  const H = 0.01;
  for (let iter = 0; iter < 20; iter++) {
    const jac = new Array<number>(n * n).fill(0);
    const err = targets.slice();
    for (let k = 0; k < n; k++) {
      const gk = g[k] ?? 0;
      const f = freqs[k] ?? 1000;
      const c0 = peaking(f, gk, q, fs);
      const cp = peaking(f, gk + H, q, fs);
      const cm = peaking(f, gk - H, q, fs);
      for (let j = 0; j < n; j++) {
        const fj = freqs[j] ?? 1000;
        err[j] = (err[j] ?? 0) - biquadMagnitudeDb(c0, fj, fs);
        jac[j * n + k] = (biquadMagnitudeDb(cp, fj, fs) - biquadMagnitudeDb(cm, fj, fs)) / (2 * H);
      }
    }
    if (Math.max(...err.map(Math.abs)) < 1e-7) break;
    const delta = solveLinear(jac, err, n);
    if (!delta) break;
    for (let k = 0; k < n; k++) {
      g[k] = clamp((g[k] ?? 0) + (delta[k] ?? 0), -MAX_SOLVED_GAIN_DB, MAX_SOLVED_GAIN_DB);
    }
  }
  return g;
}

/**
 * Filters that make the combined response at every band center equal the slider value. Bands above
 * 0.49·fs are left out; missing slider values count as 0 dB.
 */
export function solveGraphicFilters(
  bands: GraphicBands,
  gainsDb: readonly number[],
  fs: number = EQ_SAMPLE_RATE,
): FilterSpec[] {
  const q = graphicQ(bands);
  const freqs: number[] = [];
  const targets: number[] = [];
  GRAPHIC_FREQUENCIES[bands].forEach((f, i) => {
    if (f > MAX_FREQ_RATIO * fs) return;
    const s = gainsDb[i];
    freqs.push(f);
    targets.push(clamp(s !== undefined && Number.isFinite(s) ? s : 0, -MAX_SLIDER_DB, MAX_SLIDER_DB));
  });
  const gains = solveGains(freqs, targets, q, fs);
  return freqs.map((f, i) => ({ kind: "peaking", freqHz: f, gainDb: gains[i] ?? 0, q }));
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

/**
 * Response of `eq` at `points` log-spaced frequencies, including the effective preamp (manual preamp
 * minus auto headroom), like the engine's `audio_eq_response`.
 */
export function computeEqResponse(eq: EqConfig, points: number, fs: number = EQ_SAMPLE_RATE): EqResponse {
  const specs = eqFilterSpecs(eq, fs);
  const coeffs = specs.map((s) => designBiquad(s, fs));
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

import i18n from "@/i18n";
import { F_MAX, F_MIN } from "./eqMath";

/** The curve view shows ±15 dB. */
export const DB_RANGE = 15;
export const PLOT_MARGIN = { top: 10, right: 14, bottom: 26, left: 40 } as const;

export const GRID_DB = [-15, -10, -5, 0, 5, 10, 15] as const;
export const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const LOG_SPAN = Math.log(F_MAX / F_MIN);

export const freqToX = (freqHz: number, width: number): number =>
  (Math.log(clamp(freqHz, F_MIN, F_MAX) / F_MIN) / LOG_SPAN) * width;

export const xToFreq = (x: number, width: number): number =>
  F_MIN * Math.exp(clamp(width > 0 ? x / width : 0, 0, 1) * LOG_SPAN);

export const dbToY = (db: number, height: number): number => ((DB_RANGE - db) / (2 * DB_RANGE)) * height;

export const yToDb = (y: number, height: number): number =>
  clamp(DB_RANGE - (height > 0 ? y / height : 0) * 2 * DB_RANGE, -DB_RANGE, DB_RANGE);

/** SVG path through the response points, `M x y L x y …`. */
export function responsePath(frequencies: readonly number[], magnitudeDb: readonly number[], w: number, h: number) {
  return frequencies
    .map((f, i) => `${i === 0 ? "M" : "L"}${freqToX(f, w).toFixed(1)} ${dbToY(magnitudeDb[i] ?? 0, h).toFixed(1)}`)
    .join(" ");
}

/** Closed shape between the response and the 0 dB line (for the soft fill). */
export function responseArea(frequencies: readonly number[], magnitudeDb: readonly number[], w: number, h: number) {
  if (frequencies.length === 0) return "";
  const zero = dbToY(0, h).toFixed(1);
  const first = freqToX(frequencies[0] ?? F_MIN, w).toFixed(1);
  const last = freqToX(frequencies[frequencies.length - 1] ?? F_MAX, w).toFixed(1);
  return `${responsePath(frequencies, magnitudeDb, w, h)} L${last} ${zero} L${first} ${zero} Z`;
}

const number = (value: number, minDigits: number, maxDigits: number) =>
  new Intl.NumberFormat(i18n.language, { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits }).format(value);

/** "20", "500", "1k", "1.25k" (locale decimal separator) */
export function formatFrequencyShort(freqHz: number): string {
  return freqHz >= 1000 ? `${number(freqHz / 1000, 0, 2)}k` : number(freqHz, 0, 1);
}

/** "500 Hz", "1.25 kHz" */
export function formatFrequency(freqHz: number): string {
  return freqHz >= 1000 ? `${number(freqHz / 1000, 0, 2)} kHz` : `${number(freqHz, 0, 1)} Hz`;
}

/** "+3.0 dB", "−2.5 dB" */
export function formatDb(db: number, digits = 1): string {
  const rounded = Math.abs(db) < 0.5 * 10 ** -digits ? 0 : db;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${number(Math.abs(rounded), digits, digits)} dB`;
}

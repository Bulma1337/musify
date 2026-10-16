import { httpRequest } from "@/api/http";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const cache = new Map<string, Promise<Rgb | null>>();

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Picks a representative, reasonably saturated color from pixel data (RGBA), then tones it down to a
 * header-friendly lightness like the colored headers in streaming apps.
 */
export function pickHeaderColor(pixels: Uint8ClampedArray): Rgb | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number; score: number }>();
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const [, s, l] = rgbToHsl({ r, g, b });
    // Prefer colorful mid-tones over near-black/near-white pixels.
    const weight = 0.2 + s * (1 - Math.abs(l - 0.5) * 1.6);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, score: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.score += Math.max(weight, 0.05);
    buckets.set(key, bucket);
  }
  let best: { count: number; r: number; g: number; b: number; score: number } | undefined;
  for (const bucket of buckets.values()) if (!best || bucket.score > best.score) best = bucket;
  if (!best) return null;
  const avg = { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
  const [h, s, l] = rgbToHsl(avg);
  return hslToRgb(h, Math.min(s, 0.75), Math.min(Math.max(l, 0.28), 0.42));
}

async function extract(url: string): Promise<Rgb | null> {
  const response = await httpRequest(url, { timeoutMs: 15_000 });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: 32, resizeHeight: 32 });
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return pickHeaderColor(ctx.getImageData(0, 0, 32, 32).data);
}

/** Dominant header color of an image URL (fetched without CORS restrictions, cached per URL). */
export function dominantColor(url: string): Promise<Rgb | null> {
  let promise = cache.get(url);
  if (!promise) {
    promise = extract(url).catch(() => null);
    cache.set(url, promise);
  }
  return promise;
}

export const rgbCss = ({ r, g, b }: Rgb, alpha = 1) => `rgb(${r} ${g} ${b} / ${alpha})`;

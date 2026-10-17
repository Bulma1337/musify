import { httpRequest } from "@/api/http";

/**
 * Which public cover looks most like the user's own: every image is shrunk to 16 × 16 pixels and
 * compared pixel by pixel. Enough to tell editions, remasters and deluxe covers apart.
 */

/** 16 × 16 RGB values (0 … 1), row by row. */
export type Signature = Float32Array;

const SIZE = 16;

export async function imageSignature(url: string): Promise<Signature | null> {
  const response = await httpRequest(url, { timeoutMs: 8000 });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), {
    resizeWidth: SIZE,
    resizeHeight: SIZE,
    resizeQuality: "medium",
  });
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const signature = new Float32Array(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4) {
    signature[j++] = (pixels[i] ?? 0) / 255;
    signature[j++] = (pixels[i + 1] ?? 0) / 255;
    signature[j++] = (pixels[i + 2] ?? 0) / 255;
  }
  return signature;
}

/** Mean absolute difference (0 = identical, 1 = opposite). */
export function signatureDistance(a: Signature, b: Signature): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / n;
}

export interface CoverCandidate {
  /** Small image for comparing. */
  compareUrl: string;
  /** Large image for showing. */
  displayUrl: string;
}

/**
 * The candidate closest to `own`. Without an own signature, or when no candidate image loads, the
 * first candidate (the search's best match) wins.
 */
export async function pickClosest(
  own: Signature | null,
  candidates: CoverCandidate[],
  load: (url: string) => Promise<Signature | null> = imageSignature,
): Promise<CoverCandidate | null> {
  if (candidates.length === 0) return null;
  if (!own || candidates.length === 1) return candidates[0]!;
  const scored = await Promise.all(
    candidates.map(async (candidate) => {
      const signature = await load(candidate.compareUrl).catch(() => null);
      return { candidate, distance: signature ? signatureDistance(own, signature) : Infinity };
    }),
  );
  const best = scored.reduce((a, b) => (b.distance < a.distance ? b : a));
  return Number.isFinite(best.distance) ? best.candidate : candidates[0]!;
}

import type { AudioFormat } from "@/api/provider";

const LOSSLESS = new Set(["flac", "alac", "wav", "aiff", "aif", "ape", "wv", "dsf", "dff"]);

export function isLossless(format: AudioFormat): boolean {
  const codec = (format.codec ?? format.container ?? "").toLowerCase();
  // ALAC usually arrives as "m4a"; a bit depth is only reported for lossless sources.
  return LOSSLESS.has(codec) || (codec === "m4a" && !!format.bitDepth);
}

/** Short quality badge: "FLAC 24/96", "MP3 320", "AAC 256". */
export function qualityLabel(format: AudioFormat): string | null {
  const container = (format.codec ?? format.container)?.toUpperCase();
  if (!container) return null;
  if (isLossless(format)) {
    const name = container === "M4A" ? "ALAC" : container;
    if (format.bitDepth && format.sampleRate) {
      const khz = format.sampleRate / 1000;
      return `${name} ${format.bitDepth}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}`;
    }
    return name;
  }
  const name = container === "M4A" ? "AAC" : container === "OGG" ? "Vorbis" : container;
  return format.bitRate ? `${name} ${format.bitRate}` : name;
}

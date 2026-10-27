import type { AudioFormat, StreamQuality } from "@/api/provider";
import { isLossless } from "./quality";

/** MIME types a device may list for a file format (first = the one Musify announces). */
const MIMES: Record<string, string[]> = {
  flac: ["audio/flac", "audio/x-flac"],
  mp3: ["audio/mpeg", "audio/mp3", "audio/mpeg3"],
  aac: ["audio/mp4", "audio/aac", "audio/x-m4a", "audio/m4a"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"],
  alac: ["audio/x-alac", "audio/alac"],
  ogg: ["audio/ogg", "audio/x-ogg", "audio/vorbis"],
  opus: ["audio/ogg", "audio/opus"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  aiff: ["audio/aiff", "audio/x-aiff"],
  aif: ["audio/aiff", "audio/x-aiff"],
};

/** Formats nearly every device plays; assumed when a device doesn't list its formats. */
const SAFE_WHEN_UNKNOWN = new Set(["mp3", "flac"]);

/** The fallback when a device can't play the original: the server transcodes to this. */
export const FALLBACK: { quality: StreamQuality; mime: string } = {
  quality: { format: "mp3", maxBitRateKbps: 320 },
  mime: "audio/mpeg",
};

/** Normalized format name of a track: ALAC is told apart from AAC (both arrive as "m4a"). */
export function formatName(format: AudioFormat): string {
  const codec = (format.codec ?? "").toLowerCase();
  const container = (format.container ?? "").toLowerCase();
  if (codec === "alac" || (container === "m4a" && isLossless(format))) return "alac";
  if (codec && MIMES[codec]) return codec;
  return container || codec;
}

/** The MIME type to announce if the device plays `name`, otherwise null. */
export function playableMime(name: string, deviceMimes: readonly string[]): string | null {
  const candidates = MIMES[name];
  if (!candidates) return null;
  if (deviceMimes.length === 0) return SAFE_WHEN_UNKNOWN.has(name) ? candidates[0]! : null;
  const listed = candidates.find((m) => deviceMimes.includes(m));
  // Announce our usual type, as long as the device lists any spelling of it.
  return listed ? candidates[0]! : null;
}

export interface RemoteChoice {
  /** Quality to request from the server: `{}` = original. */
  quality: StreamQuality;
  mime: string;
  original: boolean;
}

/**
 * What to send a network speaker: the original when the device plays it (and its sample rate),
 * otherwise a server transcode. A transcoding stream preset keeps its bit rate and uses its format
 * if the device plays that.
 */
export function chooseRemoteFormat(
  format: AudioFormat,
  device: { mimes: readonly string[]; maxSampleRate: number | null },
  preset: StreamQuality,
): RemoteChoice {
  const transcodes = !!preset.format || !!preset.maxBitRateKbps;
  if (!transcodes) {
    const mime = playableMime(formatName(format), device.mimes);
    const rateOk = !device.maxSampleRate || !format.sampleRate || format.sampleRate <= device.maxSampleRate;
    if (mime && rateOk) return { quality: {}, mime, original: true };
    return { ...FALLBACK, original: false };
  }
  const presetMime = preset.format ? playableMime(preset.format, device.mimes) : null;
  if (presetMime) return { quality: preset, mime: presetMime, original: false };
  return {
    quality: { ...FALLBACK.quality, maxBitRateKbps: preset.maxBitRateKbps ?? 320 },
    mime: FALLBACK.mime,
    original: false,
  };
}

import i18n from "@/i18n";
import type {
  DeviceSampleFormat,
  DspConfig,
  ExclusiveCaps,
  NormalizationConfig,
  OutputFormat,
  SourceFormat,
} from "@/player/engineTypes";

const number = (value: number, maxDigits: number) =>
  new Intl.NumberFormat(i18n.language, { maximumFractionDigits: maxDigits }).format(value);

/** "44.1 kHz", "96 kHz" */
export function formatSampleRate(hz: number): string {
  return `${number(hz / 1000, 1)} kHz`;
}

/** "FLAC · 24 Bit · 96 kHz" for lossless, "MP3 · 320 kbit/s · 44.1 kHz" for lossy sources. */
export function formatSourceFormat(format: SourceFormat): string {
  const parts = [format.codec.toUpperCase()];
  if (format.bitsPerSample) parts.push(`${format.bitsPerSample} Bit`);
  else if (format.bitrateKbps) parts.push(`${Math.round(format.bitrateKbps)} kbit/s`);
  if (format.sampleRate) parts.push(formatSampleRate(format.sampleRate));
  return parts.join(" · ");
}

/** "Sound Blaster X5 · 192 kHz · 32 Bit · exclusive" */
export function formatOutputFormat(format: OutputFormat): string {
  return [
    format.deviceName,
    formatSampleRate(format.sampleRate),
    format.sampleFormat ? formatDeviceFormat(format.sampleFormat) : null,
    i18n.t(format.exclusive ? "output.exclusive" : "output.shared"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Valid bits of a device format; floats count their container. */
export function deviceFormatBits(format: DeviceSampleFormat): number {
  switch (format) {
    case "int16":
      return 16;
    case "int24":
    case "int24In32":
      return 24;
    case "int32":
    case "float32":
      return 32;
    case "float64":
      return 64;
    default:
      return 8;
  }
}

/** "24 Bit", "32 Bit", "32 Bit Float". */
export function formatDeviceFormat(format: DeviceSampleFormat): string {
  const bits = `${deviceFormatBits(format)} Bit`;
  return format === "float32" || format === "float64" ? `${bits} Float` : bits;
}

/** "Exklusiv bis 32 Bit / 384 kHz" from a device's probed capabilities (null if unknown). */
export function exclusiveSummary(caps: ExclusiveCaps | null | undefined): string | null {
  if (!caps || caps.modes.length === 0) return null;
  const maxRate = Math.max(...caps.modes.map((m) => m.sampleRate));
  const intBits = caps.modes
    .flatMap((m) => m.formats)
    .filter((f) => f.startsWith("int"))
    .map(deviceFormatBits);
  const bits = intBits.length > 0 ? Math.max(...intBits) : 32;
  return i18n.t("output.exclusiveUpTo", { bits, rate: formatSampleRate(maxRate) });
}

export type ProcessingStage = "equalizer" | "bass" | "loudness" | "limiter" | "stereo" | "normalization";

/** The processing steps that currently change the signal. */
export function activeProcessing(dsp: DspConfig, normalization: NormalizationConfig): ProcessingStage[] {
  const stages: ProcessingStage[] = [];
  if (dsp.eq.enabled) stages.push("equalizer");
  if (dsp.bass.enabled) stages.push("bass");
  if (dsp.loudnessCompensation) stages.push("loudness");
  if (dsp.limiter) stages.push("limiter");
  const { width, mono, balance } = dsp.stereo;
  if (mono || width !== 1 || balance !== 0) stages.push("stereo");
  if (normalization.mode !== "off") stages.push("normalization");
  return stages;
}

export type BitPerfectBlocker = ProcessingStage | "shared" | "volume" | "resampling" | "deviceFormat";

/**
 * Likely reasons why the output is not bit-perfect, from the settings. The engine decides the actual
 * flag; this only explains it.
 */
export function bitPerfectBlockers(input: {
  dsp: DspConfig;
  normalization: NormalizationConfig;
  volume: number;
  muted: boolean;
  source: SourceFormat | null;
  output: OutputFormat;
}): BitPerfectBlocker[] {
  const blockers: BitPerfectBlocker[] = [...activeProcessing(input.dsp, input.normalization)];
  if (!input.output.exclusive) blockers.push("shared");
  if (input.muted || input.volume < 0.999) blockers.push("volume");
  const sourceRate = input.output.sourceRate ?? input.source?.sampleRate;
  if (input.output.resampled || (sourceRate && sourceRate !== input.output.sampleRate)) {
    blockers.push("resampling");
  }
  const bits = input.source?.bitsPerSample;
  const device = input.output.sampleFormat;
  if (input.output.exclusive && bits && device && deviceFormatBits(device) < bits) {
    blockers.push("deviceFormat");
  }
  return blockers;
}

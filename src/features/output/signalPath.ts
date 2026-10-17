import i18n from "@/i18n";
import type { DspConfig, NormalizationConfig, OutputFormat, SourceFormat } from "@/player/engineTypes";

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

/** "Sound Blaster X5 · 192 kHz · exclusive" */
export function formatOutputFormat(format: OutputFormat): string {
  return [
    format.deviceName,
    formatSampleRate(format.sampleRate),
    i18n.t(format.exclusive ? "output.exclusive" : "output.shared"),
  ].join(" · ");
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

export type BitPerfectBlocker = ProcessingStage | "shared" | "volume" | "resampling";

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
  if (input.source && input.source.sampleRate !== input.output.sampleRate) blockers.push("resampling");
  return blockers;
}

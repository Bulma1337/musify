import type { OutputFormat } from "@/player/engineTypes";
import { DEFAULT_DSP } from "@/settings/store";
import { bitPerfectBlockers, exclusiveSummary, formatDeviceFormat, formatOutputFormat } from "./signalPath";

const output: OutputFormat = {
  deviceName: "DAC",
  sampleRate: 192_000,
  channels: 2,
  exclusive: true,
  bitPerfect: true,
  sampleFormat: "int32",
  sourceRate: 192_000,
  resampled: false,
  exclusiveFallback: null,
};

describe("hi-res output details", () => {
  it("names device formats by their bits", () => {
    expect(formatDeviceFormat("int24In32")).toBe("24 Bit");
    expect(formatDeviceFormat("int32")).toBe("32 Bit");
    expect(formatDeviceFormat("float32")).toBe("32 Bit Float");
  });

  it("shows the bit depth in the output line", () => {
    expect(formatOutputFormat(output)).toMatch(/^DAC · 192 kHz · 32 Bit · /);
  });

  it("summarizes the best exclusive mode of a device", () => {
    expect(
      exclusiveSummary({
        modes: [
          { sampleRate: 44_100, formats: ["int32", "float32"] },
          { sampleRate: 384_000, formats: ["int24In32"] },
        ],
      }),
    ).toMatch(/32 bit \/ 384 kHz/i);
    expect(exclusiveSummary(null)).toBeNull();
    expect(exclusiveSummary({ modes: [] })).toBeNull();
  });

  it("explains resampling and a device that can't hold the source's bits", () => {
    const blockers = bitPerfectBlockers({
      dsp: DEFAULT_DSP,
      normalization: { mode: "off", target: "normal", preventClipping: true, analyzeUntagged: true },
      volume: 1,
      muted: false,
      source: {
        codec: "flac",
        sampleRate: 352_800,
        bitsPerSample: 24,
        channels: 2,
        bitrateKbps: null,
        lossless: true,
      },
      output: { ...output, sampleRate: 44_100, sampleFormat: "int16", sourceRate: 352_800, resampled: true },
    });
    expect(blockers).toEqual(["resampling", "deviceFormat"]);
  });
});

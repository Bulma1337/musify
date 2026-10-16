import { isLossless, qualityLabel } from "./quality";

describe("quality badge", () => {
  it("formats hi-res lossless", () => {
    expect(qualityLabel({ container: "flac", bitDepth: 24, sampleRate: 96000 })).toBe("FLAC 24/96");
    expect(qualityLabel({ container: "flac", bitDepth: 16, sampleRate: 44100 })).toBe("FLAC 16/44.1");
  });

  it("detects ALAC in m4a by its bit depth", () => {
    expect(isLossless({ container: "m4a", bitDepth: 16 })).toBe(true);
    expect(qualityLabel({ container: "m4a", bitRate: 256 })).toBe("AAC 256");
  });

  it("formats lossy bitrates", () => {
    expect(qualityLabel({ container: "mp3", bitRate: 320 })).toBe("MP3 320");
    expect(qualityLabel({})).toBeNull();
  });
});

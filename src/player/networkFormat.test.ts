import { chooseRemoteFormat, formatName, playableMime } from "./networkFormat";

const flacDevice = { mimes: ["audio/x-flac", "audio/mpeg", "audio/mp4"], maxSampleRate: null };
const castLike = { mimes: ["audio/flac", "audio/mpeg", "audio/mp4", "audio/ogg"], maxSampleRate: 96_000 };

describe("formats for network speakers", () => {
  it("tells ALAC from AAC", () => {
    expect(formatName({ container: "m4a", codec: "aac", bitRate: 256 })).toBe("aac");
    expect(formatName({ container: "m4a", bitDepth: 16 })).toBe("alac");
    expect(formatName({ container: "flac" })).toBe("flac");
  });

  it("announces the usual MIME type when the device lists any spelling of it", () => {
    expect(playableMime("flac", ["audio/x-flac"])).toBe("audio/flac");
    expect(playableMime("opus", ["audio/mpeg"])).toBeNull();
    // Unknown device formats: only what nearly everything plays.
    expect(playableMime("mp3", [])).toBe("audio/mpeg");
    expect(playableMime("ogg", [])).toBeNull();
  });

  it("sends the original when the device plays it", () => {
    expect(chooseRemoteFormat({ container: "flac", sampleRate: 44_100 }, flacDevice, {})).toEqual({
      quality: {},
      mime: "audio/flac",
      original: true,
    });
  });

  it("lets the server transcode what the device can't play", () => {
    const alac = chooseRemoteFormat({ container: "m4a", bitDepth: 24 }, castLike, {});
    expect(alac).toEqual({
      quality: { format: "mp3", maxBitRateKbps: 320 },
      mime: "audio/mpeg",
      original: false,
    });
    // FLAC above the device's highest sample rate.
    const hiRes = chooseRemoteFormat({ container: "flac", sampleRate: 192_000 }, castLike, {});
    expect(hiRes.original).toBe(false);
    expect(chooseRemoteFormat({ container: "flac", sampleRate: 96_000 }, castLike, {}).original).toBe(true);
  });

  it("keeps a transcoding preset's bit rate", () => {
    const preset = { format: "opus", maxBitRateKbps: 192 };
    expect(chooseRemoteFormat({ container: "flac" }, castLike, preset)).toEqual({
      quality: preset,
      mime: "audio/ogg",
      original: false,
    });
    expect(chooseRemoteFormat({ container: "flac" }, flacDevice, preset)).toEqual({
      quality: { format: "mp3", maxBitRateKbps: 192 },
      mime: "audio/mpeg",
      original: false,
    });
  });
});

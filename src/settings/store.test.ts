import { migrateSettings, useSettings } from "./store";

describe("settings", () => {
  it("crossfade applies within albums by default", () => {
    expect(useSettings.getInitialState().crossfade.skipSameAlbum).toBe(false);
  });

  it("switches album crossfade on for settings saved before version 2", () => {
    const saved = { autoplay: false, crossfade: { durationMs: 3000, skipSameAlbum: true } };
    const migrated = migrateSettings(saved, 1);
    expect(migrated.crossfade).toEqual({ durationMs: 3000, skipSameAlbum: false });
    expect(migrated.autoplay).toBe(false);
  });

  it("keeps a choice made after version 2", () => {
    const saved = { crossfade: { durationMs: 3000, skipSameAlbum: true } };
    expect(migrateSettings(saved, 2).crossfade.skipSameAlbum).toBe(true);
  });
});

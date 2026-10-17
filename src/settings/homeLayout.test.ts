import { autoPlaylistAllowed } from "@/features/autoplaylists/availability";
import { DEFAULT_AUTO_PLAYLISTS, HOME_SECTION_IDS, moveHomeSection, normalizeHomeSections } from "./homeLayout";

describe("home sections", () => {
  it("keep the saved order, drop unknown rows and add new ones at the end", () => {
    const sections = normalizeHomeSections([
      { id: "random", visible: false },
      { id: "gone", visible: true },
      { id: "recentlyAdded", visible: true },
      { id: "random", visible: true },
    ]);
    expect(sections.slice(0, 2)).toEqual([
      { id: "random", visible: false },
      { id: "recentlyAdded", visible: true },
    ]);
    expect(sections.map((s) => s.id).sort()).toEqual([...HOME_SECTION_IDS].sort());
  });

  it("move one step and stop at the ends", () => {
    const sections = normalizeHomeSections(undefined);
    const moved = moveHomeSection(sections, "recentlyAdded", -1);
    expect(moved.map((s) => s.id).slice(0, 3)).toEqual(["autoPlaylists", "recentlyAdded", "recentlyPlayed"]);
    expect(moveHomeSection(sections, "autoPlaylists", -1)).toEqual(sections);
    expect(moveHomeSection(sections, "playlists", 1)).toEqual(sections);
  });
});

describe("automatic playlists", () => {
  const october = new Date(2026, 9, 17);
  const december = new Date(2026, 11, 2);

  it("wait for enough history", () => {
    expect(autoPlaylistAllowed({ kind: "heavyRotation" }, DEFAULT_AUTO_PLAYLISTS, 1, october)).toBe(false);
    expect(autoPlaylistAllowed({ kind: "heavyRotation" }, DEFAULT_AUTO_PLAYLISTS, 14, october)).toBe(true);
    expect(autoPlaylistAllowed({ kind: "rediscovered" }, DEFAULT_AUTO_PLAYLISTS, 30, october)).toBe(false);
    expect(autoPlaylistAllowed({ kind: "allTime" }, DEFAULT_AUTO_PLAYLISTS, 0, october)).toBe(true);
  });

  it("show this year's top songs only with the Recap, past years always", () => {
    expect(autoPlaylistAllowed({ kind: "topYear", year: 2026 }, DEFAULT_AUTO_PLAYLISTS, 300, october)).toBe(false);
    expect(autoPlaylistAllowed({ kind: "topYear", year: 2026 }, DEFAULT_AUTO_PLAYLISTS, 300, december)).toBe(true);
    expect(autoPlaylistAllowed({ kind: "topYear", year: 2025 }, DEFAULT_AUTO_PLAYLISTS, 300, october)).toBe(true);
  });

  it("can be switched off one by one or all at once", () => {
    const noAllTime = { ...DEFAULT_AUTO_PLAYLISTS, allTime: false };
    expect(autoPlaylistAllowed({ kind: "allTime" }, noAllTime, 0, october)).toBe(false);
    const off = { ...DEFAULT_AUTO_PLAYLISTS, enabled: false };
    expect(autoPlaylistAllowed({ kind: "heavyRotation" }, off, 100, october)).toBe(false);
  });
});

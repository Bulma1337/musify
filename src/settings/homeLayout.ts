/** Rows of the home page below the quick-access grid, in the user's order. */
export const HOME_SECTION_IDS = [
  "autoPlaylists",
  "recentlyPlayed",
  "recentlyAdded",
  "mostPlayed",
  "random",
  "starred",
  "playlists",
] as const;

export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

export interface HomeSectionPref {
  id: HomeSectionId;
  visible: boolean;
}

export const DEFAULT_HOME_SECTIONS: HomeSectionPref[] = HOME_SECTION_IDS.map((id) => ({ id, visible: true }));

/** Keeps the saved order, drops unknown ids and appends sections added in newer versions. */
export function normalizeHomeSections(saved: readonly { id: string; visible: boolean }[] | undefined): HomeSectionPref[] {
  const known = new Set<string>(HOME_SECTION_IDS);
  const seen = new Set<string>();
  const result: HomeSectionPref[] = [];
  for (const entry of saved ?? []) {
    if (!known.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({ id: entry.id as HomeSectionId, visible: entry.visible });
  }
  for (const id of HOME_SECTION_IDS) if (!seen.has(id)) result.push({ id, visible: true });
  return result;
}

/** Moves a section one step up (-1) or down (+1). */
export function moveHomeSection(sections: readonly HomeSectionPref[], id: HomeSectionId, step: -1 | 1): HomeSectionPref[] {
  const index = sections.findIndex((s) => s.id === id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= sections.length) return [...sections];
  const next = [...sections];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Which automatic playlists may appear. */
export interface AutoPlaylistPrefs {
  enabled: boolean;
  heavyRotation: boolean;
  rediscovered: boolean;
  allTime: boolean;
  topYear: boolean;
}

export const DEFAULT_AUTO_PLAYLISTS: AutoPlaylistPrefs = {
  enabled: true,
  heavyRotation: true,
  rediscovered: true,
  allTime: true,
  topYear: true,
};

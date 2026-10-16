import { buildRows, type LibraryEntry, type LibraryRow } from "./libraryModel";
import type { ServerLibraryPrefs } from "./libraryStore";

const entry = (key: string, kind: LibraryEntry["kind"] = "playlist"): LibraryEntry => ({
  key,
  kind,
  title: key,
  subtitle: "",
  to: `/${key}`,
});

const entries = [
  entry("liked", "liked"),
  entry("p:1"),
  entry("p:2"),
  entry("p:3"),
  entry("al:1", "album"),
  entry("ar:1", "artist"),
];

const label = (rows: LibraryRow[]) =>
  rows.map((r) =>
    r.type === "folder" ? `[${r.folder.name} ${r.count}]` : `${"-".repeat(r.depth)}${r.entry.key}`,
  );

describe("buildRows", () => {
  it("puts Favorites first, then pins in pin order, then the sorted rest", () => {
    const prefs: ServerLibraryPrefs = { pinned: ["ar:1", "p:3"], folders: [] };
    expect(label(buildRows(entries, prefs, "tree"))).toEqual(["liked", "ar:1", "p:3", "p:1", "p:2", "al:1"]);
  });

  it("shows folders after the pins with their children indented and pinned children first", () => {
    const prefs: ServerLibraryPrefs = {
      pinned: ["p:2", "al:1"],
      folders: [{ id: "f", name: "Trips", entryKeys: ["p:1", "p:2", "gone"], collapsed: false }],
    };
    expect(label(buildRows(entries, prefs, "tree"))).toEqual([
      "liked",
      "al:1",
      "[Trips 2]",
      "-p:2",
      "-p:1",
      "p:3",
      "ar:1",
    ]);
  });

  it("hides the children of a collapsed folder but keeps the count", () => {
    const prefs: ServerLibraryPrefs = {
      pinned: [],
      folders: [{ id: "f", name: "Trips", entryKeys: ["p:1"], collapsed: true }],
    };
    expect(label(buildRows(entries, prefs, "tree"))).toEqual([
      "liked",
      "[Trips 1]",
      "p:2",
      "p:3",
      "al:1",
      "ar:1",
    ]);
  });

  it("lists matches flat (no folders) while filtering or searching", () => {
    const prefs: ServerLibraryPrefs = {
      pinned: ["p:3"],
      folders: [{ id: "f", name: "Trips", entryKeys: ["p:1"], collapsed: false }],
    };
    expect(label(buildRows([entries[1]!, entries[2]!, entries[3]!], prefs, "flat"))).toEqual([
      "p:3",
      "p:1",
      "p:2",
    ]);
  });

  it("orders the rail as pinned first (also from folders), folders as icons, then the rest", () => {
    const prefs: ServerLibraryPrefs = {
      pinned: ["p:1"],
      folders: [
        { id: "f", name: "Trips", entryKeys: ["p:1", "p:2"], collapsed: false },
        { id: "g", name: "Work", entryKeys: ["p:3"], collapsed: true },
      ],
    };
    expect(label(buildRows(entries, prefs, "rail"))).toEqual([
      "liked",
      "p:1",
      "[Trips 2]",
      "-p:2",
      "[Work 1]",
      "al:1",
      "ar:1",
    ]);
  });
});

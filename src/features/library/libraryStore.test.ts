import { EMPTY_PREFS, useLibrary } from "./libraryStore";

const prefs = () => useLibrary.getState().byServer.s1 ?? EMPTY_PREFS;

beforeEach(() => useLibrary.setState({ byServer: {} }));

describe("library preferences", () => {
  it("keeps pins in pin order and unpins on the second toggle", () => {
    const { togglePin } = useLibrary.getState();
    togglePin("s1", "ar:2");
    togglePin("s1", "p:1");
    togglePin("s1", "al:3");
    expect(prefs().pinned).toEqual(["ar:2", "p:1", "al:3"]);
    togglePin("s1", "p:1");
    expect(prefs().pinned).toEqual(["ar:2", "al:3"]);
  });

  it("never pins or unpins Favorites (it is always pinned)", () => {
    useLibrary.getState().togglePin("s1", "liked");
    expect(prefs().pinned).toEqual([]);
  });

  it("stores preferences per server", () => {
    useLibrary.getState().togglePin("s1", "p:1");
    expect(useLibrary.getState().byServer.s2).toBeUndefined();
  });

  it("creates, renames and deletes folders; deleting moves the items back to the top level", () => {
    const lib = useLibrary.getState();
    const a = lib.createFolder("s1", " Road ");
    const b = lib.createFolder("s1", "Work");
    expect(prefs().folders.map((f) => f.name)).toEqual(["Road", "Work"]);

    lib.renameFolder("s1", a, "Trips");
    lib.renameFolder("s1", b, "   ");
    expect(prefs().folders.map((f) => f.name)).toEqual(["Trips", "Work"]);

    lib.moveToFolder("s1", "p:1", a);
    lib.moveToFolder("s1", "p:2", a);
    expect(prefs().folders[0]!.entryKeys).toEqual(["p:1", "p:2"]);

    lib.deleteFolder("s1", a);
    expect(prefs().folders.map((f) => f.id)).toEqual([b]);
    // The playlists are in no folder any more.
    expect(prefs().folders.flatMap((f) => f.entryKeys)).toEqual([]);
  });

  it("files an entry into one folder at a time and only accepts playlists", () => {
    const lib = useLibrary.getState();
    const a = lib.createFolder("s1", "A");
    const b = lib.createFolder("s1", "B");
    lib.moveToFolder("s1", "p:1", a);
    lib.moveToFolder("s1", "p:1", b);
    lib.moveToFolder("s1", "al:9", a);
    lib.moveToFolder("s1", "p:2", "missing");
    expect(prefs().folders.map((f) => f.entryKeys)).toEqual([[], ["p:1"]]);
    lib.moveToFolder("s1", "p:1", null);
    expect(prefs().folders.map((f) => f.entryKeys)).toEqual([[], []]);
  });

  it("toggles the collapsed state of a folder", () => {
    const lib = useLibrary.getState();
    const id = lib.createFolder("s1", "A");
    expect(prefs().folders[0]!.collapsed).toBe(false);
    lib.toggleFolder("s1", id);
    expect(prefs().folders[0]!.collapsed).toBe(true);
  });
});

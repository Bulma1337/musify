import { resolveStarred, starredChange, useStarredChanges } from "./starred";

describe("favorite changes", () => {
  afterEach(() => useStarredChanges.setState({ changes: {} }));

  it("win over the flag of a loaded item until they are undone", () => {
    const { set, restore } = useStarredChanges.getState();
    expect(resolveStarred(useStarredChanges.getState().changes, "srv", "track", "t1", false)).toBe(false);

    set("srv", "track", "t1", true);
    const changes = useStarredChanges.getState().changes;
    expect(resolveStarred(changes, "srv", "track", "t1", false)).toBe(true);
    // Other servers and kinds are not affected.
    expect(resolveStarred(changes, "other", "track", "t1", false)).toBe(false);
    expect(resolveStarred(changes, "srv", "album", "t1", false)).toBe(false);

    restore("srv", "track", "t1", undefined);
    expect(starredChange("srv", "track", "t1")).toBeUndefined();
  });
});

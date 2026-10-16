import { serverLabel } from "./serverLabel";

describe("serverLabel", () => {
  it("strips Navidrome's build hash", () => {
    expect(
      serverLabel({
        kind: "subsonic",
        url: "x",
        serverType: "navidrome",
        serverVersion: "0.64.2 (10114574)",
      }),
    ).toBe("Navidrome 0.64.2");
  });

  it("keeps plain versions and unknown server types", () => {
    expect(serverLabel({ kind: "subsonic", url: "x", serverType: "foo", serverVersion: "1.2" })).toBe(
      "foo 1.2",
    );
    expect(serverLabel({ kind: "subsonic", url: "x" })).toBe("Subsonic");
  });
});

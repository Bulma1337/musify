import { collectMessages } from "./index";

/** Flattens nested translation objects into dotted keys. */
function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("locales", () => {
  it("German and English define the same keys (shared and feature files)", () => {
    expect(keys(collectMessages("en")).sort()).toEqual(keys(collectMessages("de")).sort());
  });
});

import de from "./locales/de.json";
import en from "./locales/en.json";

/** Flattens nested translation objects into dotted keys. */
function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("locales", () => {
  it("German and English define the same keys", () => {
    expect(keys(en).sort()).toEqual(keys(de).sort());
  });
});

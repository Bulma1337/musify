import i18n from "@/i18n";
import { applyStoredLanguage, useLanguage } from "./language";

const KEY = "navify.settings.json.navify.language";

/** What zustand's persist middleware writes through our storage adapter (a JSON string, JSON-encoded again). */
function store(language: unknown) {
  localStorage.setItem(KEY, JSON.stringify(JSON.stringify({ state: { language }, version: 1 })));
}

beforeEach(async () => {
  localStorage.removeItem(KEY);
  useLanguage.setState({ language: null });
  await i18n.changeLanguage("en");
});

describe("applyStoredLanguage", () => {
  it("switches i18n to the stored language before anything renders", async () => {
    store("de");
    expect(i18n.language).toBe("en");
    await applyStoredLanguage();
    expect(i18n.language).toBe("de");
    expect(useLanguage.getState().language).toBe("de");
    expect(i18n.t("settings.title")).toBe("Einstellungen");
  });

  it("keeps the system language when nothing valid is stored", async () => {
    store("klingon");
    await applyStoredLanguage();
    expect(i18n.language).toBe("en");
    expect(useLanguage.getState().language).toBeNull();
  });

  it("keeps the system language when nothing is stored", async () => {
    await applyStoredLanguage();
    expect(i18n.language).toBe("en");
  });
});

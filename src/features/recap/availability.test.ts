import { bannerYear, recapPhase } from "./availability";

describe("recapPhase", () => {
  it("is locked before December 1", () => {
    expect(recapPhase(2026, new Date(2026, 10, 30, 23, 59))).toBe("locked");
    expect(recapPhase(2027, new Date(2026, 11, 15))).toBe("locked");
  });

  it("is a preview from December 1 until December 30", () => {
    expect(recapPhase(2026, new Date(2026, 11, 1, 0, 0))).toBe("preview");
    expect(recapPhase(2026, new Date(2026, 11, 30, 23, 59))).toBe("preview");
  });

  it("is final from December 31 and for past years", () => {
    expect(recapPhase(2026, new Date(2026, 11, 31, 0, 0))).toBe("final");
    expect(recapPhase(2025, new Date(2026, 3, 2))).toBe("final");
  });
});

describe("bannerYear", () => {
  it("only shows in December", () => {
    expect(bannerYear(new Date(2026, 10, 30))).toBeNull();
    expect(bannerYear(new Date(2027, 0, 2))).toBeNull();
    expect(bannerYear(new Date(2026, 11, 3))).toEqual({ year: 2026, phase: "preview" });
    expect(bannerYear(new Date(2026, 11, 31))).toEqual({ year: 2026, phase: "final" });
  });
});

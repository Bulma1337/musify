import { rangeBounds, rangeKey } from "./ranges";

const noon = new Date(2026, 9, 17, 15, 30); // Oct 17, 2026, local time

describe("rangeBounds", () => {
  it("covers four weeks up to the end of today", () => {
    const { from, to } = rangeBounds({ kind: "weeks4" }, noon);
    expect(new Date(from)).toEqual(new Date(2026, 8, 20));
    expect(new Date(to)).toEqual(new Date(2026, 9, 18));
  });

  it("covers six calendar months", () => {
    const { from, to } = rangeBounds({ kind: "months6" }, noon);
    expect(new Date(from)).toEqual(new Date(2026, 3, 17));
    expect(new Date(to)).toEqual(new Date(2026, 9, 18));
  });

  it("covers a calendar year in local time", () => {
    const { from, to } = rangeBounds({ kind: "year", year: 2025 }, noon);
    expect(new Date(from)).toEqual(new Date(2025, 0, 1));
    expect(new Date(to)).toEqual(new Date(2026, 0, 1));
  });

  it("starts at zero for all time", () => {
    expect(rangeBounds({ kind: "all" }, noon).from).toBe(0);
  });

  it("is stable through the day, so cache keys do not change", () => {
    const morning = rangeBounds({ kind: "weeks4" }, new Date(2026, 9, 17, 0, 5));
    const evening = rangeBounds({ kind: "weeks4" }, new Date(2026, 9, 17, 23, 55));
    expect(morning).toEqual(evening);
  });
});

describe("rangeKey", () => {
  it("includes the year", () => {
    expect(rangeKey({ kind: "year", year: 2024 })).toBe("year-2024");
    expect(rangeKey({ kind: "all" })).toBe("all");
  });
});

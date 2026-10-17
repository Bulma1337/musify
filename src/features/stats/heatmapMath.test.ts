import { calendarWeeks, CALENDAR_WEEKS, heatLevel, localDayNumber, weekdayOf } from "./heatmapMath";

describe("listening calendar", () => {
  it("numbers local days like the history and knows their weekday", () => {
    const day = localDayNumber(new Date(2026, 9, 17));
    expect(weekdayOf(day)).toBe(5); // 17 October 2026 is a Saturday (Monday = 0)
    expect(localDayNumber(new Date(2026, 9, 18)) - day).toBe(1);
  });

  it("lays out Monday-first weeks and marks days outside the range", () => {
    const saturday = localDayNumber(new Date(2026, 9, 17));
    const weeks = calendarWeeks([{ day: saturday, playedMs: 60_000 }], saturday - 13, saturday);
    expect(weeks).toHaveLength(3);
    expect(weekdayOf(weeks[0]![0]!.day)).toBe(0);
    const last = weeks.at(-1)!;
    expect(last[5]).toEqual({ day: saturday, playedMs: 60_000, outside: false });
    expect(last[6]!.outside).toBe(true); // Sunday is still to come
    expect(weeks[0]![0]!.outside).toBe(true); // before the range
  });

  it("shows at most a year", () => {
    const today = localDayNumber(new Date(2026, 9, 17));
    expect(calendarWeeks([], 0, today)).toHaveLength(CALENDAR_WEEKS);
  });

  it("grades cells in five steps", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(30, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
  });
});

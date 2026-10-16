import { greetingForHour } from "./greeting";

describe("greetingForHour", () => {
  it.each([
    [0, "evening"],
    [4, "evening"],
    [5, "morning"],
    [10, "morning"],
    [11, "day"],
    [17, "day"],
    [18, "evening"],
    [23, "evening"],
  ] as const)("hour %i -> %s", (hour, expected) => {
    expect(greetingForHour(hour)).toBe(expected);
  });
});

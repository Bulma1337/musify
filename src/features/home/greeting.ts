export type Greeting = "morning" | "day" | "evening";

/** Picks the greeting for a local hour of day (0–23). */
export function greetingForHour(hour: number): Greeting {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 18) return "day";
  return "evening";
}

import type { Track } from "@/api/provider";
import { buildPlayRecord } from "@/features/stats/recorder";
import type { PlayRecord } from "@/features/stats/history";
import { memoryHistory } from "@/features/stats/memoryHistory";
import { fakeTracks } from "./fakeProvider";

/** Unix ms of a local date and time. */
export const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

/** One history row for a fake-library track; `counted` plays by default. */
export function playRow(
  track: Track,
  startedAt: number,
  extra: { playedMs?: number; counted?: boolean; completed?: boolean; tzOffsetMin?: number } = {},
): PlayRecord {
  const counted = extra.counted ?? true;
  return buildPlayRecord(track, {
    startedAt,
    playedMs: extra.playedMs ?? (counted ? track.durationMs : 8_000),
    completed: extra.completed ?? counted,
    counted,
    tzOffsetMin: extra.tzOffsetMin ?? -new Date(startedAt).getTimezoneOffset(),
  });
}

export const track = (id: string): Track => {
  const found = fakeTracks.find((t) => t.id === id);
  if (!found) throw new Error(`no fake track ${id}`);
  return found;
};

/** Plays `id` once on each of the given days of a month (noon, local time). */
export function playOnDays(id: string, year: number, month: number, days: number[]): PlayRecord[] {
  return days.map((d) => playRow(track(id), at(year, month, d)));
}

/**
 * A believable year of listening on the fake library: t1 is the favorite, a few others trail it,
 * with plays spread over several months, hours and weekdays.
 */
export function sampleYear(year: number): PlayRecord[] {
  const rows: PlayRecord[] = [];
  const plan: [string, number][] = [
    ["t1", 30],
    ["t7", 18],
    ["t4", 12],
    ["t2", 7],
    ["t9", 4],
    ["t5", 2],
  ];
  for (const [id, count] of plan) {
    for (let i = 0; i < count; i++) {
      const month = 1 + ((i * 5 + id.length * 3) % 12);
      const day = 1 + ((i * 7) % 27);
      rows.push(playRow(track(id), at(year, month, day, 8 + ((i * 3) % 14), (i * 11) % 60)));
    }
  }
  // A skip and a streak of consecutive days in March.
  rows.push(playRow(track("t3"), at(year, 4, 2), { counted: false }));
  rows.push(...playOnDays("t1", year, 3, [10, 11, 12, 13, 14]));
  return rows;
}

export function seedHistory(rows: PlayRecord[]) {
  memoryHistory.replaceAll(rows);
}

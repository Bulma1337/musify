import type { Track } from "@/api/provider";

export type ShuffleAlgorithm = "random" | "balanced";

function fisherYates<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const artistKey = (track: Track) =>
  (track.artists[0]?.id ?? track.artists[0]?.name ?? track.artistLine).toLowerCase();

/**
 * Play order over `tracks` indices that starts with `first`.
 *
 * - `random`: uniform Fisher–Yates.
 * - `balanced`: spreads each artist's tracks evenly over the list (each artist gets positions
 *   k/n with a random offset and a little jitter), so the same artist rarely plays twice in a row.
 */
export function shuffleOrder(
  tracks: readonly Track[],
  first: number,
  algorithm: ShuffleAlgorithm,
  random: () => number = Math.random,
): number[] {
  const indices = tracks.map((_, i) => i).filter((i) => i !== first);
  if (algorithm === "random") return [first, ...fisherYates(indices, random)];

  const groups = new Map<string, number[]>();
  for (const i of indices) {
    const key = artistKey(tracks[i]!);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const placed: { position: number; index: number }[] = [];
  for (const group of groups.values()) {
    const shuffled = fisherYates(group, random);
    const n = shuffled.length;
    const offset = random() / n;
    shuffled.forEach((index, k) => {
      const jitter = ((random() - 0.5) * 0.2) / n;
      placed.push({ position: k / n + offset + jitter, index });
    });
  }
  placed.sort((a, b) => a.position - b.position);
  return [first, ...placed.map((p) => p.index)];
}

/**
 * Interleaves recommendations into an order: after every `every` items one recommendation index
 * (indices `recommendedFrom…` in the item list) is inserted.
 */
export function interleave(order: readonly number[], recommended: readonly number[], every = 3): number[] {
  const result: number[] = [];
  let r = 0;
  order.forEach((index, i) => {
    result.push(index);
    if ((i + 1) % every === 0 && r < recommended.length) result.push(recommended[r++]!);
  });
  return result;
}

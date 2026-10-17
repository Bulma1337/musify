import type { Track } from "@/api/provider";
import { fakeTracks } from "@/test/fakeProvider";
import { interleave, shuffleOrder } from "./shuffle";

/** Deterministic PRNG for repeatable tests. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function library(artists: number, perArtist: number): Track[] {
  const tracks: Track[] = [];
  for (let a = 0; a < artists; a++) {
    for (let t = 0; t < perArtist; t++) {
      const base = fakeTracks[0]!;
      tracks.push({
        ...base,
        id: `a${a}t${t}`,
        artists: [{ id: `artist${a}`, name: `Artist ${a}` }],
        artistLine: `Artist ${a}`,
      });
    }
  }
  return tracks;
}

function adjacentRepeats(tracks: Track[], order: number[]): number {
  let repeats = 0;
  for (let i = 1; i < order.length; i++) {
    if (tracks[order[i]!]!.artists[0]!.id === tracks[order[i - 1]!]!.artists[0]!.id) repeats++;
  }
  return repeats;
}

describe("shuffleOrder", () => {
  it("is a permutation that starts with the chosen track", () => {
    const tracks = library(4, 5);
    for (const algorithm of ["random", "balanced"] as const) {
      const order = shuffleOrder(tracks, 7, algorithm, seeded(1));
      expect(order[0]).toBe(7);
      expect([...order].sort((a, b) => a - b)).toEqual(tracks.map((_, i) => i));
    }
  });

  it("balanced shuffle repeats artists back-to-back far less than random", () => {
    const tracks = library(5, 8);
    let random = 0;
    let balanced = 0;
    for (let seed = 1; seed <= 50; seed++) {
      random += adjacentRepeats(tracks, shuffleOrder(tracks, 0, "random", seeded(seed)));
      balanced += adjacentRepeats(tracks, shuffleOrder(tracks, 0, "balanced", seeded(seed)));
    }
    expect(balanced).toBeLessThan(random / 2);
  });
});

describe("interleave", () => {
  it("inserts one recommendation after every third item", () => {
    expect(interleave([0, 1, 2, 3, 4, 5, 6], [10, 11, 12])).toEqual([0, 1, 2, 10, 3, 4, 5, 11, 6]);
  });
});

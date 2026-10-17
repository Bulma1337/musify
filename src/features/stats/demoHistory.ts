import type { MusicProvider, Track } from "@/api/provider";
import { inTauri } from "@/lib/platform";
import { seededRandom } from "@/lib/random";
import { buildPlayRecord } from "./recorder";
import type { PlayRecord } from "./history";
import { memoryHistory } from "./memoryHistory";

/**
 * Generated listening history for the browser preview, so the Stats page, the automatic playlists
 * and the Recap can be developed without a real history. Deterministic (seeded random numbers) so
 * screenshots stay comparable. Never used inside the app.
 */

const ARTISTS = [
  "Aurora Lane",
  "Kollektiv Nord",
  "Mira Voss",
  "The Paper Tigers",
  "Lumen Choir",
  "Tomás Rey",
  "Salt & Static",
  "Nell Harbor",
  "Okapi Club",
  "Violet Meridian",
  "Hanno Brandt",
  "Glass Orchard",
];
const GENRES = ["Electronic", "Indie", "Jazz", "Pop", "Rock", "Ambient", "Hip-Hop", "Klassik"];
const WORDS = [
  "Static",
  "Morning",
  "Harbor",
  "Echo",
  "Velvet",
  "Lantern",
  "Signal",
  "Drift",
  "Paper",
  "Neon",
  "Ember",
  "Orbit",
  "Tide",
  "Mosaic",
  "Hollow",
  "Satellite",
];

/** Invented catalog for previews without a server library. */
export function syntheticTracks(serverId: string, random: () => number): Track[] {
  const tracks: Track[] = [];
  let n = 0;
  for (const [a, artist] of ARTISTS.entries()) {
    const genre = GENRES[(a * 3 + 1) % GENRES.length]!;
    for (let al = 0; al < 2; al++) {
      const album = `${WORDS[(a + al * 5) % WORDS.length]} ${WORDS[(a * 2 + al + 7) % WORDS.length]}`;
      for (let i = 0; i < 6; i++) {
        n += 1;
        const title = `${WORDS[(n * 3) % WORDS.length]} ${WORDS[(n * 7 + 2) % WORDS.length]}`;
        tracks.push({
          id: `demo-t${n}`,
          serverId,
          title,
          artists: [{ id: `demo-ar${a}`, name: artist }],
          artistLine: artist,
          albumArtists: [{ id: `demo-ar${a}`, name: artist }],
          album: { id: `demo-al${a}-${al}`, name: album },
          durationMs: Math.round(150_000 + random() * 120_000),
          genres: [genre],
          format: {},
          starred: false,
        });
      }
    }
  }
  return tracks;
}

/** How likely each hour is to start a listening session on weekdays / weekends. */
const WEEKDAY_HOURS = [
  1, 0.6, 0.3, 0.2, 0.2, 0.5, 1.5, 3, 3.5, 2.5, 2, 2, 2.5, 2, 2, 2.5, 3, 3.5, 3, 4, 5, 6, 5, 3,
];
const WEEKEND_HOURS = [
  2, 1.5, 0.8, 0.3, 0.2, 0.3, 0.5, 1, 2, 3, 3.5, 4, 4, 4, 4.5, 4.5, 4, 4, 4.5, 5, 5.5, 5.5, 5, 3.5,
];

function pickWeighted(weights: number[], random: () => number): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = random() * total;
  for (const [i, w] of weights.entries()) {
    r -= w;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * About three years of listening up to `now`: some tracks are loved for a while and then forgotten
 * (so "Wiederentdeckt" has candidates), a few are always around, and there are quiet gaps.
 */
export function generateDemoHistory(tracks: Track[], now: Date): PlayRecord[] {
  if (tracks.length === 0) return [];
  const random = seededRandom(20260101);
  const rows: PlayRecord[] = [];
  const years = 3;
  const start = new Date(now.getFullYear() - years + 1, 0, 1);
  const days = Math.ceil((now.getTime() - start.getTime()) / 86_400_000);

  const intensity = Math.min(1, Math.max(0.2, tracks.length / 120));

  // Every track gets a favorite period (center day and width) and a base popularity.
  const profile = tracks.map((_, i) => ({
    center: random() * days,
    width: 20 + random() * 120,
    base: Math.pow(random(), 2.2) * (i % 9 === 0 ? 3 : 1),
    evergreen: random() < 0.12,
  }));

  for (let d = 0; d < days; d++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    // Quiet stretches of a few days now and then, otherwise active most days.
    if (Math.sin(d / 9.3) + random() * 0.8 < -0.55) continue;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const sessions = 1 + Math.floor(random() * (weekend ? 4 : 3));
    const weights = profile.map((p, i) => {
      const bump = Math.exp(-(((d - p.center) / p.width) ** 2));
      return 0.02 + p.base * (p.evergreen ? 0.35 + bump : bump * 2) + (i % 17 === 0 ? 0.05 : 0);
    });
    for (let s = 0; s < sessions; s++) {
      const hour = pickWeighted(weekend ? WEEKEND_HOURS : WEEKDAY_HOURS, random);
      let at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, Math.floor(random() * 50));
      // Small libraries get fewer plays per session, so counts stay believable.
      const count = Math.max(2, Math.round((3 + Math.floor(random() * 9)) * intensity));
      for (let k = 0; k < count; k++) {
        const track = tracks[pickWeighted(weights, random)]!;
        const skip = random() < 0.14;
        const playedMs = skip
          ? Math.round(4_000 + random() * 22_000)
          : Math.round(track.durationMs * (0.85 + random() * 0.15));
        const counted = !skip && playedMs >= 30_000;
        rows.push(
          buildPlayRecord(track, {
            startedAt: at.getTime(),
            playedMs,
            completed: !skip && playedMs >= track.durationMs * 0.95,
            counted,
            context:
              random() < 0.6 ? { type: "album", id: track.album?.id } : { type: "playlist", id: "demo" },
          }),
        );
        at = new Date(at.getTime() + playedMs + 1500);
      }
    }
  }
  return rows;
}

const seeding = new Map<string, Promise<void>>();

/**
 * Fills the in-memory history with demo data once per server, but only in the dev browser preview
 * (never in the app, never in tests). Uses the connected server's real tracks when it has some, so
 * played-from-list works; falls back to an invented catalog.
 */
export function prepareHistory(provider: MusicProvider): Promise<void> {
  if (inTauri || !import.meta.env.DEV || import.meta.env.MODE === "test") return Promise.resolve();
  const id = provider.server.id;
  let job = seeding.get(id);
  if (!job) {
    job = (async () => {
      if (memoryHistory.count(id) > 0) return;
      const random = seededRandom(7);
      let tracks: Track[] = [];
      try {
        tracks = await provider.getRandomTracks({ size: 150 });
      } catch {
        // Offline preview: use the invented catalog.
      }
      if (tracks.length < 12) tracks = syntheticTracks(id, random);
      memoryHistory.addAll(generateDemoHistory(tracks, new Date()));
    })();
    seeding.set(id, job);
  }
  return job;
}

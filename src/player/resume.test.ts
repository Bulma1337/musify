import { fakeTracks } from "@/test/fakeProvider";
import { decideResume, queueSnapshot } from "./resume";
import { usePlayer } from "./store";

const MIN = 60_000;
const now = Date.parse("2026-10-17T12:00:00Z");

describe("decideResume", () => {
  it("continues locally when playback stopped within the window", () => {
    expect(
      decideResume({
        local: { savedAt: now - 4 * MIN, wasPlaying: true, serverId: "s" },
        remoteAt: null,
        now,
        windowMin: 10,
        remoteMatchesLocal: false,
      }),
    ).toEqual({ action: "continue" });
  });

  it("does not start playing after the window or when it was paused", () => {
    const base = { remoteAt: null, now, windowMin: 10, remoteMatchesLocal: false };
    expect(
      decideResume({ ...base, local: { savedAt: now - 11 * MIN, wasPlaying: true, serverId: "s" } }),
    ).toEqual({ action: "none" });
    expect(
      decideResume({ ...base, local: { savedAt: now - 1 * MIN, wasPlaying: false, serverId: "s" } }),
    ).toEqual({ action: "none" });
    expect(
      decideResume({
        ...base,
        windowMin: 0,
        local: { savedAt: now - 1 * MIN, wasPlaying: true, serverId: "s" },
      }),
    ).toEqual({ action: "none" });
  });

  it("takes over a newer queue from another device and plays it if it is recent", () => {
    const local = { savedAt: now - 60 * MIN, wasPlaying: true, serverId: "s" };
    expect(
      decideResume({ local, remoteAt: now - 3 * MIN, now, windowMin: 10, remoteMatchesLocal: false }),
    ).toEqual({ action: "adopt", play: true });
    expect(
      decideResume({ local, remoteAt: now - 30 * MIN, now, windowMin: 10, remoteMatchesLocal: false }),
    ).toEqual({ action: "adopt", play: false });
  });

  it("ignores the server queue when it is our own save or the same as what is loaded", () => {
    const local = { savedAt: now - 2 * MIN, wasPlaying: true, serverId: "s" };
    // Saved at the same moment as the local state (our own save on close).
    expect(
      decideResume({ local, remoteAt: local.savedAt + 1000, now, windowMin: 10, remoteMatchesLocal: false }),
    ).toEqual({ action: "continue" });
    expect(
      decideResume({ local, remoteAt: now - 1 * MIN, now, windowMin: 10, remoteMatchesLocal: true }),
    ).toEqual({ action: "continue" });
  });
});

describe("queueSnapshot and restoreQueue", () => {
  beforeEach(() => usePlayer.getState().resetQueue());

  it("flattens played, current, manually queued and upcoming tracks in play order", () => {
    const tracks = fakeTracks.slice(0, 4);
    usePlayer.getState().playTracks(tracks, 1, { type: "album", id: "al1", name: "A" });
    usePlayer.getState().addToQueue([fakeTracks[5]!]);
    const snap = queueSnapshot(usePlayer.getState())!;
    expect(snap.tracks.map((t) => t.id)).toEqual(["t1", "t2", "t6", "t3", "t4"]);
    expect(snap.index).toBe(1);
  });

  it("restores a saved queue at its position without playing, or playing right away", () => {
    const before = usePlayer.getState().startNonce;
    usePlayer.getState().restoreQueue({
      tracks: fakeTracks.slice(0, 3),
      index: 2,
      positionMs: 42_000,
      context: { type: "queue", name: "Q" },
      play: false,
    });
    let s = usePlayer.getState();
    expect(s.current?.track.id).toBe("t3");
    expect(s.positionMs).toBe(42_000);
    expect(s.isPlaying).toBe(false);
    expect(s.startNonce).toBe(before);

    usePlayer.getState().restoreQueue({
      tracks: fakeTracks.slice(0, 3),
      index: 0,
      positionMs: 5_000,
      context: { type: "queue", name: "Q" },
      play: true,
    });
    s = usePlayer.getState();
    expect(s.current?.track.id).toBe("t1");
    expect(s.isPlaying).toBe(true);
    expect(s.startNonce).toBe(before + 1);
  });
});

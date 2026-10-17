import { fakeTracks } from "@/test/fakeProvider";
import { applyMediaAction } from "./mediaSession";
import { usePlayer } from "./store";

describe("media keys", () => {
  beforeEach(() => {
    usePlayer.getState().resetQueue();
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, { type: "album", id: "al1", name: "A" });
    usePlayer.getState().setProgress(30_000, 200_000);
  });

  it("toggles, pauses and plays", () => {
    applyMediaAction({ action: "toggle" });
    expect(usePlayer.getState().isPlaying).toBe(false);
    applyMediaAction({ action: "play" });
    expect(usePlayer.getState().isPlaying).toBe(true);
    applyMediaAction({ action: "stop" });
    expect(usePlayer.getState().isPlaying).toBe(false);
  });

  it("skips and seeks", () => {
    applyMediaAction({ action: "next" });
    expect(usePlayer.getState().current?.track.id).toBe("t2");
    usePlayer.getState().setProgress(30_000, 200_000);
    applyMediaAction({ action: "seekBy", offsetMs: -40_000 });
    expect(usePlayer.getState().positionMs).toBe(0);
    applyMediaAction({ action: "seekTo", positionMs: 90_000 });
    expect(usePlayer.getState().positionMs).toBe(90_000);
  });
});

import { useEffect, useState } from "react";
import { usePlayer, type PlayerState } from "@/player/store";
import { PlaybackClock } from "./timing";

export interface LyricsClockOptions {
  /**
   * Minimum change in ms before the returned value updates. 0 (default) = every animation frame
   * (karaoke fill); larger values keep re-renders cheap when line precision is enough.
   */
  intervalMs?: number;
}

const wallClock = () => performance.now();

/** Position jumps (seek, new track, restart) must not be smoothed. */
function isDiscontinuity(state: PlayerState, previous: PlayerState): boolean {
  return (
    state.seekNonce !== previous.seekNonce ||
    state.startNonce !== previous.startNonce ||
    state.current?.key !== previous.current?.key
  );
}

/**
 * Smooth playback position in ms. The player store reports the position about 10 times per second;
 * between reports the value is interpolated on every animation frame while playing. Seeks and track
 * changes snap to the reported position.
 */
export function useLyricsClock({ intervalMs = 0 }: LyricsClockOptions = {}): number {
  const [positionMs, setPositionMs] = useState(() => usePlayer.getState().positionMs);

  useEffect(() => {
    const clock = new PlaybackClock();
    let frame = 0;
    let last = Number.NaN;

    const commit = (force: boolean) => {
      const value = Math.round(clock.now(wallClock()));
      if (force || Math.abs(value - last) >= intervalMs) {
        last = value;
        setPositionMs(value);
      }
    };
    const isRunning = (s: PlayerState) => s.isPlaying && !s.buffering && s.current !== null;

    const loop = () => {
      commit(false);
      frame = requestAnimationFrame(loop);
    };
    const stopLoop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const initial = usePlayer.getState();
    clock.update(initial.positionMs, isRunning(initial), wallClock(), true);
    commit(true);
    if (isRunning(initial)) frame = requestAnimationFrame(loop);

    const unsubscribe = usePlayer.subscribe((state, previous) => {
      if (
        state.positionMs === previous.positionMs &&
        state.isPlaying === previous.isPlaying &&
        state.buffering === previous.buffering &&
        !isDiscontinuity(state, previous)
      ) {
        return;
      }
      const running = isRunning(state);
      clock.update(state.positionMs, running, wallClock(), isDiscontinuity(state, previous));
      commit(true);
      if (running && frame === 0) frame = requestAnimationFrame(loop);
      else if (!running) stopLoop();
    });

    return () => {
      unsubscribe();
      stopLoop();
    };
  }, [intervalMs]);

  return positionMs;
}

import { fakeTracks } from "@/test/fakeProvider";
import { peekNext, upcomingContextItems, usePlayer } from "./store";

const context = { type: "album" as const, id: "al1", name: "Morning Static" };

function reset() {
  usePlayer.setState({
    context: null,
    contextItems: [],
    order: [],
    orderIndex: 0,
    manualQueue: [],
    current: null,
    history: [],
    isPlaying: false,
    shuffle: "off",
    repeat: "off",
  });
}

describe("player store", () => {
  beforeEach(reset);

  it("user actions bump startNonce, engine advances do not", () => {
    const s = usePlayer.getState();
    s.playTracks(fakeTracks.slice(0, 3), 0, context);
    const afterPlay = usePlayer.getState().startNonce;
    const next = peekNext(usePlayer.getState())!;
    expect(next.track.id).toBe("t2");

    usePlayer.getState().advanceTo(next.key);
    expect(usePlayer.getState().current?.track.id).toBe("t2");
    expect(usePlayer.getState().startNonce).toBe(afterPlay);

    usePlayer.getState().next();
    expect(usePlayer.getState().current?.track.id).toBe("t3");
    expect(usePlayer.getState().startNonce).toBe(afterPlay + 1);
  });

  it("upcomingContextItems returns the same array while the queue is unchanged (stable selector)", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 4), 0, context);
    const first = upcomingContextItems(usePlayer.getState());
    expect(first.map((i) => i.track.id)).toEqual(["t2", "t3", "t4"]);
    usePlayer.getState().setProgress(1000);
    expect(upcomingContextItems(usePlayer.getState())).toBe(first);
    usePlayer.getState().next();
    const afterNext = upcomingContextItems(usePlayer.getState());
    expect(afterNext).not.toBe(first);
    expect(afterNext.map((i) => i.track.id)).toEqual(["t3", "t4"]);
  });

  it("manual queue plays before the context continues", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, context);
    usePlayer.getState().addToQueue([fakeTracks[8]!]);
    const next = peekNext(usePlayer.getState())!;
    expect(next.track.id).toBe("t9");
    usePlayer.getState().advanceTo(next.key);
    expect(usePlayer.getState().manualQueue).toHaveLength(0);
    expect(peekNext(usePlayer.getState())?.track.id).toBe("t2");
  });

  it("repeat-one preloads the same item, repeat-all wraps around", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 2), 1, context);
    usePlayer.setState({ repeat: "one" });
    expect(peekNext(usePlayer.getState())?.key).toBe(usePlayer.getState().current?.key);
    usePlayer.setState({ repeat: "off" });
    expect(peekNext(usePlayer.getState())).toBeNull();
    usePlayer.setState({ repeat: "all" });
    expect(peekNext(usePlayer.getState())?.track.id).toBe("t1");
  });

  it("previous restarts after 3 seconds via a seek", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 1, context);
    usePlayer.setState({ positionMs: 5000 });
    const seeks = usePlayer.getState().seekNonce;
    usePlayer.getState().previous();
    expect(usePlayer.getState().current?.track.id).toBe("t2");
    expect(usePlayer.getState().seekNonce).toBe(seeks + 1);
    usePlayer.getState().previous();
    expect(usePlayer.getState().current?.track.id).toBe("t1");
  });
});

describe("skipping a track that can't be played", () => {
  beforeEach(reset);

  it("steps over the next context item without playing it", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, context);
    const broken = peekNext(usePlayer.getState())!;
    usePlayer.getState().skipUpcoming(broken.key);
    const s = usePlayer.getState();
    expect(s.current?.track.id).toBe("t1");
    expect(peekNext(s)?.track.id).toBe("t3");
    expect(upcomingContextItems(s).map((i) => i.track.id)).toEqual(["t3"]);
    // The engine then moves on to t3 by itself.
    usePlayer.getState().advanceTo(peekNext(s)!.key);
    expect(usePlayer.getState().current?.track.id).toBe("t3");
  });

  it("drops a broken manually queued item", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 2), 0, context);
    usePlayer.getState().addToQueue([fakeTracks[8]!]);
    usePlayer.getState().skipUpcoming(peekNext(usePlayer.getState())!.key);
    expect(usePlayer.getState().manualQueue).toHaveLength(0);
    expect(peekNext(usePlayer.getState())?.track.id).toBe("t2");
  });

  it("wraps around with repeat all and leaves other items alone", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 2, context);
    usePlayer.setState({ repeat: "all" });
    const first = peekNext(usePlayer.getState())!;
    expect(first.track.id).toBe("t1");
    usePlayer.getState().skipUpcoming("someone-else");
    expect(peekNext(usePlayer.getState())).toBe(first);
    usePlayer.getState().skipUpcoming(first.key);
    expect(peekNext(usePlayer.getState())?.track.id).toBe("t2");
  });

  it("never skips the current item (repeat one)", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 2), 0, context);
    usePlayer.setState({ repeat: "one" });
    const current = usePlayer.getState().current!;
    usePlayer.getState().skipUpcoming(current.key);
    expect(usePlayer.getState().current).toBe(current);
    expect(peekNext(usePlayer.getState())).toBe(current);
  });
});

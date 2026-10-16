import { fakeTracks } from "@/test/fakeProvider";
import { peekNext, usePlayer } from "./store";

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

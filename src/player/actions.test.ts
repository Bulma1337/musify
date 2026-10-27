import { fakeTracks } from "@/test/fakeProvider";
import { playOrToggle } from "./actions";
import { usePlayer } from "./store";

const context = { type: "album" as const, id: "al1", name: "Morning Static" };
const tracks = fakeTracks.slice(0, 4);

describe("playOrToggle", () => {
  beforeEach(() => {
    usePlayer.setState({
      context: null,
      current: null,
      contextItems: [],
      order: [],
      orderIndex: 0,
      shuffle: "off",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts at the first track", async () => {
    playOrToggle(context, () => tracks);
    await vi.waitFor(() => expect(usePlayer.getState().current?.track.id).toBe("t1"));
  });

  it("starts at a random track while shuffle is on", async () => {
    usePlayer.setState({ shuffle: "shuffle" });
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    playOrToggle(context, () => tracks);
    await vi.waitFor(() => expect(usePlayer.getState().current?.track.id).toBe("t4"));
  });

  it("keeps an explicit start track", async () => {
    usePlayer.setState({ shuffle: "shuffle" });
    playOrToggle(context, () => tracks, 1);
    await vi.waitFor(() => expect(usePlayer.getState().current?.track.id).toBe("t2"));
  });
});

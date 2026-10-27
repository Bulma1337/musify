import { useSession } from "@/api/session";
import { useToasts } from "@/components/ui/toast";
import i18n from "@/i18n";
import { resetDownloads } from "@/test/downloads";
import { createFakeProvider, fakeTracks } from "@/test/fakeProvider";
import { connectNetworkDevice, disconnectNetworkDevice, startEngineBridge } from "./bridge";
import type { EngineCommand, EngineEvent } from "./engineTypes";
import { networkApi, useNetwork, type NetworkEvent, type SessionInfo } from "./network";
import { usePlayer } from "./store";

vi.mock("@/features/downloads/api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const engine = vi.hoisted(() => {
  const sent: unknown[] = [];
  let listener: (event: unknown) => void = () => {};
  return {
    sent,
    emit: (event: unknown) => listener(event),
    client: {
      send: (command: unknown) => sent.push(command),
      subscribe: (l: (event: unknown) => void) => {
        listener = l;
      },
      subscribeSpectrum: () => {},
      devices: async () => [],
      eqResponse: async () => null,
      parseAutoEq: async () => ({}),
    },
  };
});
vi.mock("./engine", async (original) => ({
  ...(await original<typeof import("./engine")>()),
  audioEngine: () => engine.client,
}));

const speaker: SessionInfo = {
  device: { id: "upnp:uuid:1", name: "Living room", protocol: "upnp", kind: "speaker", model: null },
  mimes: ["audio/flac", "audio/mpeg"],
  maxSampleRate: null,
  volume: 0.25,
};

const context = { type: "album" as const, id: "al1", name: "Morning Static" };
const local = () => engine.sent as EngineCommand[];

describe("network speakers in the player", () => {
  let stop: () => void;
  let remote: EngineCommand[];
  let fromNetwork: (event: NetworkEvent) => void;

  beforeEach(() => {
    resetDownloads();
    useSession.setState({ provider: createFakeProvider(), status: "ready", offline: false });
    useToasts.setState({ toasts: [] });
    useNetwork.setState({ devices: [speaker.device], scanning: false, connecting: null, active: null });
    usePlayer.setState({
      manualQueue: [],
      history: [],
      repeat: "off",
      shuffle: "off",
      volume: 0.8,
      muted: false,
    });
    engine.sent.length = 0;
    remote = [];
    fromNetwork = () => {};
    vi.spyOn(networkApi, "send").mockImplementation((command) => void remote.push(command));
    vi.spyOn(networkApi, "subscribe").mockImplementation((listener) => {
      fromNetwork = listener;
    });
    vi.spyOn(networkApi, "connect").mockResolvedValue(speaker);
    vi.spyOn(networkApi, "disconnect").mockResolvedValue();
    stop = startEngineBridge();
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
  });

  function playing() {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, context);
    usePlayer.getState().setProgress(42_000);
    engine.sent.length = 0;
  }

  it("moves playback to the speaker at the current position", async () => {
    playing();
    await connectNetworkDevice(speaker.device.id);

    expect(local()).toContainEqual({ type: "stop" });
    const play = remote.find((c) => c.type === "play");
    expect(play).toMatchObject({ startMs: 42_000, paused: false });
    expect(play?.type === "play" && play.track.remote).toMatchObject({
      title: fakeTracks[0]!.title,
      mime: expect.stringMatching(/^audio\//),
    });
    // The slider shows the speaker's volume now.
    expect(usePlayer.getState().volume).toBe(0.25);
    expect(useNetwork.getState().active?.device.name).toBe("Living room");

    // Controls go to the speaker, not to this computer.
    usePlayer.getState().togglePlay();
    expect(remote.at(-1)).toEqual({ type: "pause" });
    usePlayer.getState().setVolume(0.5);
    expect(remote.at(-1)).toEqual({ type: "setVolume", volume: 0.5 });
    expect(local().filter((c) => c.type === "pause" || c.type === "setVolume")).toEqual([]);
  });

  it("follows the speaker's events and ignores the local engine meanwhile", async () => {
    playing();
    await connectNetworkDevice(speaker.device.id);
    const second = usePlayer.getState().contextItems[1]!;
    const event: EngineEvent = {
      type: "trackStarted",
      id: second.key,
      transition: "gapless",
      durationMs: 1000,
      format: {
        codec: "",
        sampleRate: 0,
        bitsPerSample: null,
        channels: 2,
        bitrateKbps: null,
        lossless: false,
      },
    };
    fromNetwork({ type: "engine", event });
    expect(usePlayer.getState().current?.key).toBe(second.key);

    engine.emit({ type: "stateChanged", state: "stopped" });
    expect(usePlayer.getState().current?.key).toBe(second.key);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });

  it("goes back to this computer at the position", async () => {
    playing();
    await connectNetworkDevice(speaker.device.id);
    usePlayer.getState().setProgress(61_000);
    engine.sent.length = 0;

    await disconnectNetworkDevice();
    expect(networkApi.disconnect).toHaveBeenCalled();
    expect(useNetwork.getState().active).toBeNull();
    expect(local()).toContainEqual({ type: "setVolume", volume: 0.8 });
    expect(local().find((c) => c.type === "play")).toMatchObject({ startMs: 61_000, paused: false });
    expect(usePlayer.getState().volume).toBe(0.8);
  });

  it("falls back to this computer, paused, with one message when the speaker is lost", async () => {
    playing();
    await connectNetworkDevice(speaker.device.id);
    engine.sent.length = 0;

    fromNetwork({ type: "sessionEnded", reason: { kind: "lost", message: "timed out" } });
    await vi.waitFor(() => expect(local().some((c) => c.type === "play")).toBe(true));

    expect(local().find((c) => c.type === "play")).toMatchObject({ paused: true, startMs: 42_000 });
    expect(usePlayer.getState().isPlaying).toBe(false);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      i18n.t("output.network.lost", { name: "Living room" }),
    ]);
  });

  it("reports a failed connection and stays here", async () => {
    vi.mocked(networkApi.connect).mockRejectedValueOnce(new Error("refused"));
    playing();
    await connectNetworkDevice(speaker.device.id);
    expect(useNetwork.getState().active).toBeNull();
    expect(local()).not.toContainEqual({ type: "stop" });
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("keeps the device list current", () => {
    fromNetwork({ type: "devices", devices: [] });
    expect(useNetwork.getState().devices).toEqual([]);
    fromNetwork({ type: "scanning", active: true });
    expect(useNetwork.getState().scanning).toBe(true);
  });
});

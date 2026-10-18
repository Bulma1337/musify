import { useSession } from "@/api/session";
import { useToasts } from "@/components/ui/toast";
import i18n from "@/i18n";
import { resetDownloads } from "@/test/downloads";
import { createFakeProvider, fakeTracks } from "@/test/fakeProvider";
import { startEngineBridge } from "./bridge";
import type { EngineCommand, EngineEvent } from "./engineTypes";
import { peekNext, usePlayer } from "./store";

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

const context = { type: "album" as const, id: "al1", name: "Morning Static" };
const emit = (event: EngineEvent) => engine.emit(event);
const sent = () => engine.sent as EngineCommand[];
const lastNext = () =>
  sent()
    .filter((c) => c.type === "setNext")
    .at(-1);

describe("engine errors", () => {
  let stop: () => void;

  beforeEach(() => {
    resetDownloads();
    useSession.setState({ provider: createFakeProvider(), status: "ready", offline: false });
    useToasts.setState({ toasts: [] });
    usePlayer.setState({ manualQueue: [], history: [], repeat: "off", shuffle: "off" });
    engine.sent.length = 0;
    stop = startEngineBridge();
  });

  afterEach(() => stop());

  it("skips a next track the server no longer has, with one message", () => {
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, context);
    const [first, second, third] = usePlayer.getState().contextItems;
    expect(lastNext()).toMatchObject({ track: { id: second!.key } });

    // What the engine reports when the track is gone (Navidrome answers with an error document).
    emit({
      type: "error",
      id: second!.key,
      kind: "server",
      message: "data not found (code 70)",
      recoverable: true,
    });
    emit({ type: "needNext", id: first!.key });

    expect(lastNext()).toMatchObject({ track: { id: third!.key } });
    expect(peekNext(usePlayer.getState())?.key).toBe(third!.key);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([
      i18n.t("player.trackUnavailable", { title: second!.track.title }),
    ]);

    // The engine plays the third track after the first; the queue follows.
    emit({
      type: "trackStarted",
      id: third!.key,
      transition: "gapless",
      durationMs: 1000,
      format: {
        codec: "FLAC",
        sampleRate: 44_100,
        bitsPerSample: 16,
        channels: 2,
        bitrateKbps: null,
        lossless: true,
        float: false,
      },
    });
    expect(usePlayer.getState().current?.key).toBe(third!.key);
  });

  it("keeps the queue when the network fails (offline check instead)", () => {
    const check = vi.spyOn(useSession.getState(), "checkConnection").mockResolvedValue();
    usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, context);
    const second = usePlayer.getState().contextItems[1]!;
    emit({
      type: "error",
      id: second.key,
      kind: "network",
      message: "connection refused",
      recoverable: true,
    });
    expect(peekNext(usePlayer.getState())?.key).toBe(second.key);
    expect(check).toHaveBeenCalled();
  });
});

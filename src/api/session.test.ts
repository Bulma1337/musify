import { OfflineProvider } from "@/features/downloads/offlineProvider";
import { useDownloads } from "@/features/downloads/store";
import { createFakeProvider, fakeServer } from "@/test/fakeProvider";
import { ProviderError, type MusicProvider } from "./provider";
import { factoryFor } from "./registry";
import { useSession } from "./session";

vi.mock("./registry", () => ({ factoryFor: vi.fn() }));
vi.mock("./secrets", () => ({
  loadSecret: vi.fn(async () => "secret"),
  saveSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
}));
vi.mock("@/lib/persist", () => ({
  readPersisted: vi.fn(async (_file: string, key: string) => (key === "servers" ? [fakeServer] : null)),
  writePersisted: vi.fn(async () => {}),
}));
vi.mock("@/features/downloads/api", async () => (await import("@/test/downloadsApiMock")).downloadsApiMock());

const networkError = () => new ProviderError("network", "unreachable");

/** Makes `factoryFor(...).connect` follow the given outcomes in order (the last one repeats). */
function connectOutcomes(...outcomes: (MusicProvider | ProviderError)[]) {
  const connect = vi.fn(async () => {
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
    if (next instanceof ProviderError) throw next;
    return next;
  });
  vi.mocked(factoryFor).mockReturnValue({ connect } as never);
  return connect;
}

beforeEach(() => {
  vi.useFakeTimers();
  useDownloads.getState().reset();
  useSession.setState({
    servers: [],
    activeServerId: undefined,
    provider: null,
    status: "loading",
    error: undefined,
    offline: false,
    reconnecting: false,
  });
});

afterEach(async () => {
  // Stop any reconnect timer the session left behind.
  vi.mocked(factoryFor).mockReturnValue({ connect: async () => createFakeProvider() } as never);
  await useSession.getState().reconnect();
  vi.useRealTimers();
});

describe("session connection", () => {
  it("connects normally when the server answers", async () => {
    connectOutcomes(createFakeProvider());
    await useSession.getState().init();
    const state = useSession.getState();
    expect(state).toMatchObject({ status: "ready", offline: false });
    expect(state.provider?.server.id).toBe("srv1");
    expect(state.provider).not.toBeInstanceOf(OfflineProvider);
  });

  it("starts in offline mode when the server can't be reached", async () => {
    connectOutcomes(networkError());
    await useSession.getState().init();
    const state = useSession.getState();
    expect(state).toMatchObject({ status: "ready", offline: true, reconnecting: false });
    expect(state.provider).toBeInstanceOf(OfflineProvider);
    expect(useDownloads.getState().serverId).toBe("srv1");
    await expect(state.provider!.ping()).rejects.toMatchObject({ kind: "network" });
  });

  it("treats timeouts like an unreachable server", async () => {
    connectOutcomes(new ProviderError("timeout", "slow"));
    await useSession.getState().init();
    expect(useSession.getState().offline).toBe(true);
  });

  it("does not go offline for a refused login", async () => {
    connectOutcomes(new ProviderError("auth", "nope"));
    await useSession.getState().init();
    expect(useSession.getState()).toMatchObject({ status: "error", offline: false, provider: null });
  });

  it("reconnects by itself with growing pauses and leaves offline mode", async () => {
    const online = createFakeProvider();
    const connect = connectOutcomes(networkError(), networkError(), networkError(), online);
    await useSession.getState().init();
    expect(useSession.getState().offline).toBe(true);

    await vi.advanceTimersByTimeAsync(4_900);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); // 5 s: first retry fails
    expect(connect).toHaveBeenCalledTimes(2);
    expect(useSession.getState().offline).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(connect).toHaveBeenCalledTimes(2); // next one only after 10 s
    await vi.advanceTimersByTimeAsync(1_500);
    expect(connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_500); // 20 s later it works
    expect(connect).toHaveBeenCalledTimes(4);

    const state = useSession.getState();
    expect(state.offline).toBe(false);
    expect(state.provider).not.toBeInstanceOf(OfflineProvider);
    expect(state.provider?.server.id).toBe("srv1");
    // No further attempts once connected.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("reconnects right away on request", async () => {
    connectOutcomes(networkError(), createFakeProvider());
    await useSession.getState().init();
    await useSession.getState().retryNow();
    expect(useSession.getState()).toMatchObject({ offline: false, reconnecting: false });
  });

  it("falls back to the login when the server rejects the stored credentials while offline", async () => {
    connectOutcomes(networkError(), new ProviderError("auth", "changed password"));
    await useSession.getState().init();
    await useSession.getState().retryNow();
    expect(useSession.getState()).toMatchObject({ status: "error", offline: false, provider: null });
    expect(useSession.getState().error?.kind).toBe("auth");
  });
});

describe("connection loss while the app is running", () => {
  async function connected() {
    const raw = createFakeProvider();
    connectOutcomes(raw, networkError());
    await useSession.getState().init();
    return raw;
  }

  it("switches to offline mode when a request fails and the server doesn't answer a ping", async () => {
    const raw = await connected();
    vi.spyOn(raw, "getAlbum").mockRejectedValue(networkError());
    vi.spyOn(raw, "ping").mockRejectedValue(networkError());
    await expect(useSession.getState().provider!.getAlbum("al1")).rejects.toMatchObject({ kind: "network" });
    await vi.waitFor(() => expect(useSession.getState().offline).toBe(true));
    expect(useSession.getState().provider).toBeInstanceOf(OfflineProvider);
  });

  it("stays online when only one request failed", async () => {
    const raw = await connected();
    vi.spyOn(raw, "getAlbum").mockRejectedValue(networkError());
    const ping = vi.spyOn(raw, "ping").mockResolvedValue();
    await expect(useSession.getState().provider!.getAlbum("al1")).rejects.toMatchObject({ kind: "network" });
    await vi.waitFor(() => expect(ping).toHaveBeenCalled());
    expect(useSession.getState().offline).toBe(false);
  });

  it("does not ping after errors that are not about the connection", async () => {
    const raw = await connected();
    vi.spyOn(raw, "getAlbum").mockRejectedValue(new ProviderError("notFound", "gone"));
    const ping = vi.spyOn(raw, "ping");
    await expect(useSession.getState().provider!.getAlbum("al1")).rejects.toMatchObject({ kind: "notFound" });
    expect(ping).not.toHaveBeenCalled();
  });

  it("goes offline when the engine reports a network error for a stream", async () => {
    const raw = await connected();
    vi.spyOn(raw, "ping").mockRejectedValue(new ProviderError("timeout", "slow"));
    await useSession.getState().checkConnection();
    expect(useSession.getState().offline).toBe(true);
  });
});

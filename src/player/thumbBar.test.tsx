import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { useSession } from "@/api/session";
import { useStarredChanges } from "@/api/starred";
import { createFakeProvider, fakeTracks } from "@/test/fakeProvider";
import { usePlayer } from "./store";
import { applyThumbBarClick, thumbBarState, useThumbBar, type ThumbBarState } from "./thumbBar";

const native = vi.hoisted(() => ({
  tauri: false,
  invoke: vi.fn((_command: string, _args?: unknown) => Promise.resolve()),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

// Only the hook under test runs "inside Tauri"; modules read the flag when they need it.
vi.mock("@/lib/platform", () => ({
  get inTauri() {
    return native.tauri;
  },
}));
// Stores would otherwise save through the Tauri store plugin while the flag is on.
vi.mock("@/lib/persist", () => ({
  readPersisted: () => Promise.resolve(undefined),
  writePersisted: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: native.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    native.listeners.set(event, handler);
    return Promise.resolve(() => native.listeners.delete(event));
  },
}));

function play() {
  usePlayer.getState().resetQueue();
  usePlayer.getState().playTracks(fakeTracks.slice(0, 3), 0, { type: "album", id: "al1", name: "A" });
}

function lastState(): ThumbBarState {
  const call = native.invoke.mock.calls.filter(([command]) => command === "thumbbar_update").at(-1);
  return (call?.[1] as { state: ThumbBarState }).state;
}

async function click(button: string) {
  await waitFor(() => expect(native.listeners.has("thumbbar-click")).toBe(true));
  act(() => {
    native.listeners.get("thumbbar-click")!({ payload: { button } });
  });
}

describe("thumbBarState", () => {
  it("enables every button with a track and labels them in the app language", () => {
    const state = thumbBarState({ hasTrack: true, playing: true, liked: false }, i18n.t);
    expect(state).toMatchObject({
      playing: true,
      liked: false,
      canLike: true,
      canToggle: true,
      hasPrevious: true,
      hasNext: true,
    });
    expect(state.labels).toEqual({
      like: i18n.t("menu.addToLiked"),
      unlike: i18n.t("menu.removeFromLiked"),
      play: i18n.t("player.play"),
      pause: i18n.t("player.pause"),
      previous: i18n.t("player.previous"),
      next: i18n.t("player.next"),
    });
  });

  it("disables everything when nothing is loaded", () => {
    const state = thumbBarState({ hasTrack: false, playing: false, liked: false }, i18n.t);
    expect(state).toMatchObject({ canLike: false, canToggle: false, hasPrevious: false, hasNext: false });
  });
});

describe("applyThumbBarClick", () => {
  beforeEach(play);

  it("runs the transport buttons like the player bar", () => {
    const like = vi.fn();
    applyThumbBarClick("toggle", like);
    expect(usePlayer.getState().isPlaying).toBe(false);
    applyThumbBarClick("next", like);
    expect(usePlayer.getState().current?.track.id).toBe("t2");
    applyThumbBarClick("previous", like);
    expect(usePlayer.getState().current?.track.id).toBe("t1");
    expect(like).not.toHaveBeenCalled();
    applyThumbBarClick("like", like);
    expect(like).toHaveBeenCalledOnce();
  });
});

describe("useThumbBar", () => {
  let provider: ReturnType<typeof createFakeProvider>;

  function renderThumbBar() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderHook(() => useThumbBar(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }

  beforeEach(() => {
    native.tauri = true;
    native.invoke.mockClear();
    native.listeners.clear();
    provider = createFakeProvider();
    useSession.setState({ provider, status: "ready", offline: false });
    useStarredChanges.setState({ changes: {} });
    play();
  });

  afterEach(() => {
    native.tauri = false;
  });

  it("forwards play state changes", async () => {
    renderThumbBar();
    await waitFor(() => expect(lastState()).toMatchObject({ playing: true, liked: false, canToggle: true }));
    act(() => {
      usePlayer.getState().togglePlay();
    });
    await waitFor(() => expect(lastState().playing).toBe(false));
    act(() => {
      usePlayer.getState().resetQueue();
    });
    await waitFor(() =>
      expect(lastState()).toMatchObject({ canLike: false, canToggle: false, hasNext: false }),
    );
  });

  it("runs clicked transport buttons", async () => {
    renderThumbBar();
    await click("next");
    expect(usePlayer.getState().current?.track.id).toBe("t2");
    await click("toggle");
    expect(usePlayer.getState().isPlaying).toBe(false);
    await click("previous");
    expect(usePlayer.getState().current?.track.id).toBe("t1");
  });

  it("likes and unlikes the current track through the shared favorite state", async () => {
    renderThumbBar();
    await click("like");
    await waitFor(() => expect(lastState().liked).toBe(true));
    expect(provider.calls).toContainEqual({ method: "setStarred", args: ["track", "t1", true] });
    await click("like");
    await waitFor(() => expect(lastState().liked).toBe(false));
    expect(provider.calls).toContainEqual({ method: "setStarred", args: ["track", "t1", false] });
  });

  it("follows favorites changed elsewhere and hides the buttons when unmounted", async () => {
    const { unmount } = renderThumbBar();
    act(() => {
      useStarredChanges.getState().set(provider.server.id, "track", "t1", true);
    });
    await waitFor(() => expect(lastState().liked).toBe(true));
    unmount();
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("thumbbar_clear", undefined));
    expect(native.listeners.has("thumbbar-click")).toBe(false);
  });
});

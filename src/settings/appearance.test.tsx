import { renderHook } from "@testing-library/react";
import { usePlayer } from "@/player/store";
import { useAppearance } from "./appearance";
import { useSettings } from "./store";

const cover = vi.hoisted(() => ({ color: { r: 40, g: 80, b: 180 }, calls: [] as unknown[] }));
vi.mock("@/components/media/useCoverColor", () => ({
  useCoverColor: (c: unknown) => {
    cover.calls.push(c);
    return cover.color;
  },
}));

const root = document.documentElement;

afterEach(() => {
  useSettings.setState({ accent: "purple" });
  root.removeAttribute("data-accent");
  root.removeAttribute("style");
  cover.calls.length = 0;
});

describe("useAppearance", () => {
  it("sets data-accent for the fixed accents and leaves the shades to the stylesheet", () => {
    useSettings.setState({ accent: "blue" });
    renderHook(() => useAppearance());
    expect(root.dataset.accent).toBe("blue");
    expect(root.style.getPropertyValue("--accent-500")).toBe("");
  });

  it("derives the shades from the cover in dynamic mode and removes them when leaving it", () => {
    usePlayer.setState({
      current: { key: "k", manual: false, track: { cover: { id: "c1" } } as never },
    });
    useSettings.setState({ accent: "dynamic" });
    const { rerender } = renderHook(() => useAppearance());
    expect(root.dataset.accent).toBe("dynamic");
    const base = root.style.getPropertyValue("--accent-500");
    expect(base).toMatch(/^#[0-9a-f]{6}$/);
    expect(base).not.toBe("#8b5cf6");
    expect(root.style.getPropertyValue("--accent-400")).toMatch(/^#[0-9a-f]{6}$/);
    expect(root.style.getPropertyValue("--accent-600")).toMatch(/^#[0-9a-f]{6}$/);
    // The cover is only looked at in dynamic mode.
    expect(cover.calls.at(-1)).toEqual({ id: "c1" });

    useSettings.setState({ accent: "red" });
    rerender();
    expect(root.dataset.accent).toBe("red");
    expect(root.style.getPropertyValue("--accent-500")).toBe("");
    expect(cover.calls.at(-1)).toBeUndefined();
  });
});

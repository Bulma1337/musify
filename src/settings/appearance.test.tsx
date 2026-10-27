import { renderHook } from "@testing-library/react";
import { accentFill, accentPreset } from "./accentPresets";
import { useAppearance } from "./appearance";
import { useSettings } from "./store";

const root = document.documentElement;

afterEach(() => {
  useSettings.setState({ accent: "ember" });
  root.removeAttribute("data-accent");
  root.removeAttribute("style");
});

describe("useAppearance", () => {
  it("applies a solid accent: shades, the color on it, no gradient fill", () => {
    useSettings.setState({ accent: "blue" });
    renderHook(() => useAppearance());
    expect(root.dataset.accent).toBe("blue");
    expect(root.style.getPropertyValue("--accent-500")).toBe("#3d8bff");
    expect(root.style.getPropertyValue("--accent-on")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--accent-fill")).toBe("none");
  });

  it("applies a gradient accent and switches back", () => {
    useSettings.setState({ accent: "ocean" });
    const { rerender } = renderHook(() => useAppearance());
    expect(root.style.getPropertyValue("--accent-fill")).toBe(accentFill(accentPreset("ocean")));
    expect(root.style.getPropertyValue("--accent-on")).toBe("#0b0b10");

    useSettings.setState({ accent: "red" });
    rerender();
    expect(root.dataset.accent).toBe("red");
    expect(root.style.getPropertyValue("--accent-fill")).toBe("none");
  });

  it("uses the default accent for an id it does not know", () => {
    useSettings.setState({ accent: "dynamic" });
    renderHook(() => useAppearance());
    expect(root.dataset.accent).toBe("ember");
  });
});

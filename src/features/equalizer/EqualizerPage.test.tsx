import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EqConfig } from "@/player/engineTypes";
import { DEFAULT_DSP, useSettings } from "@/settings/store";
import { renderPage } from "@/test/renderPage";
import { clearEqMemory, snapshotDsp } from "./eqActions";
import { EqualizerPage } from "./EqualizerPage";
import { resampleGraphicGains } from "./eqMath";
import { BUILT_IN_PRESETS } from "./presets";

const engine = vi.hoisted(() => ({
  send: vi.fn(),
  subscribe: vi.fn(),
  subscribeSpectrum: vi.fn(),
  devices: vi.fn(async () => []),
  eqResponse: vi.fn(async () => null),
  parseAutoEq: vi.fn(),
}));
vi.mock("@/player/engine", () => ({ audioEngine: () => engine }));

function reset() {
  clearEqMemory();
  useSettings.setState({
    dsp: structuredClone(DEFAULT_DSP),
    eqPresetId: null,
    customPresets: [],
  });
}

const eq = () => useSettings.getState().dsp.eq;
const gains = () => {
  const mode = eq().mode;
  return mode.type === "graphic" ? mode.gainsDb : [];
};

beforeEach(() => {
  reset();
  engine.send.mockClear();
  engine.parseAutoEq.mockReset();
  // jsdom has no canvas; the analyzer just skips drawing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const presetTrigger = () => screen.getByRole("button", { name: "Preset" });

/** Opens the preset menu with the keyboard and picks an entry by its visible name. */
function choosePreset(name: string) {
  fireEvent.keyDown(presetTrigger(), { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function renderEqualizer() {
  return renderPage(<EqualizerPage />, { path: "/equalizer", url: "/equalizer" });
}

describe("EqualizerPage", () => {
  it("switches the equalizer on and off in the settings store", () => {
    renderEqualizer();
    const power = screen.getByRole("switch", { name: "Equalizer on or off" });
    expect(power).toHaveAttribute("aria-checked", "false");
    fireEvent.click(power);
    expect(eq().enabled).toBe(true);
    fireEvent.click(power);
    expect(eq().enabled).toBe(false);
  });

  it("draws the response curve and the grid", () => {
    renderEqualizer();
    expect(screen.getByRole("img", { name: /Frequency response/ })).toBeInTheDocument();
  });

  it("asks the analyzer to run while the page is open", () => {
    const { unmount } = renderEqualizer();
    expect(engine.send).toHaveBeenCalledWith({ type: "setSpectrum", enabled: true });
    unmount();
    expect(engine.send).toHaveBeenLastCalledWith({ type: "setSpectrum", enabled: false });
  });

  describe("mode tabs", () => {
    const tabs = () =>
      ["10 bands", "31 bands", "Parametric"].map((name) => screen.getByRole("tab", { name }));
    const selectedStates = () => tabs().map((tab) => tab.getAttribute("aria-selected"));

    it("marks exactly the tab of the current mode as selected, in every mode", () => {
      renderEqualizer();
      expect(selectedStates()).toEqual(["true", "false", "false"]);
      fireEvent.click(screen.getByRole("tab", { name: "31 bands" }));
      expect(selectedStates()).toEqual(["false", "true", "false"]);
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
      fireEvent.click(screen.getByRole("tab", { name: "Parametric" }));
      expect(selectedStates()).toEqual(["false", "false", "true"]);
      fireEvent.click(screen.getByRole("tab", { name: "10 bands" }));
      expect(selectedStates()).toEqual(["true", "false", "false"]);
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName("10 bands");
    });

    it("follows a mode change that did not come from the tabs (preset, reset)", () => {
      renderEqualizer();
      fireEvent.click(screen.getByRole("tab", { name: "31 bands" }));
      expect(selectedStates()).toEqual(["false", "true", "false"]);
      act(() => {
        useSettings.setState({ dsp: structuredClone(DEFAULT_DSP) });
      });
      expect(selectedStates()).toEqual(["true", "false", "false"]);
    });

    it("moves between the tabs with the arrow keys", () => {
      renderEqualizer();
      fireEvent.keyDown(screen.getByRole("tab", { name: "10 bands" }), { key: "ArrowRight" });
      expect(selectedStates()).toEqual(["false", "true", "false"]);
      expect(screen.getByRole("tab", { name: "31 bands" })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("tab", { name: "31 bands" }), { key: "End" });
      expect(selectedStates()).toEqual(["false", "false", "true"]);
      fireEvent.keyDown(screen.getByRole("tab", { name: "Parametric" }), { key: "ArrowRight" });
      expect(selectedStates()).toEqual(["true", "false", "false"]);
    });
  });

  describe("preset menu", () => {
    it("lists own presets and built-in presets in groups and checks the current one", () => {
      useSettings.setState({
        customPresets: [{ id: "c1", name: "Warm", dsp: snapshotDsp(structuredClone(DEFAULT_DSP)) }],
        eqPresetId: "c1",
      });
      renderEqualizer();
      expect(presetTrigger()).toHaveTextContent("Warm");
      fireEvent.keyDown(presetTrigger(), { key: "Enter" });
      expect(screen.getByText("My presets")).toBeInTheDocument();
      expect(screen.getByText("Built-in presets")).toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: "Warm" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "Rock" })).toHaveAttribute("aria-checked", "false");
    });

    it("applies the preset chosen with the keyboard and shows it checked afterwards", () => {
      renderEqualizer();
      fireEvent.keyDown(presetTrigger(), { key: "ArrowDown" });
      expect(screen.getByRole("menuitemradio", { name: "Custom curve" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Jazz" }), { key: "Enter" });
      expect(useSettings.getState().eqPresetId).toBe("jazz");
      expect(presetTrigger()).toHaveTextContent("Jazz");
      fireEvent.keyDown(presetTrigger(), { key: "Enter" });
      expect(screen.getByRole("menuitemradio", { name: "Jazz" })).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("presets", () => {
    it("applies a built-in preset: curve, EQ on, preset id", () => {
      renderEqualizer();
      choosePreset("Rock");
      const rock = BUILT_IN_PRESETS.find((p) => p.id === "rock")!;
      expect(eq().enabled).toBe(true);
      expect(eq().mode).toEqual({ type: "graphic", bands: "ten", gainsDb: [...rock.gainsDb] });
      expect(eq().autoHeadroom).toBe(true);
      expect(useSettings.getState().eqPresetId).toBe("rock");
      expect(useSettings.getState().dsp.bass.enabled).toBe(false);
    });

    it("the Deep Bass preset also turns the bass enhancer on", () => {
      renderEqualizer();
      choosePreset("Deep Bass");
      const { bass } = useSettings.getState().dsp;
      expect(bass).toMatchObject({ enabled: true, boostDb: 6, frequencyHz: 80 });
      expect(screen.getByRole("switch", { name: "Deep Bass" })).toHaveAttribute("aria-checked", "true");
    });

    it("keeps the 31-band layout when a built-in preset is chosen", () => {
      renderEqualizer();
      fireEvent.click(screen.getByRole("tab", { name: "31 bands" }));
      choosePreset("V shape");
      const vShape = BUILT_IN_PRESETS.find((p) => p.id === "vShape")!;
      expect(eq().mode).toEqual({
        type: "graphic",
        bands: "thirtyOne",
        gainsDb: resampleGraphicGains(vShape.gainsDb, "ten", "thirtyOne"),
      });
    });

    it("editing a band leaves the built-in preset (shows a custom curve)", () => {
      renderEqualizer();
      choosePreset("Flat");
      expect(useSettings.getState().eqPresetId).toBe("flat");
      fireEvent.keyDown(screen.getByRole("slider", { name: "1 kHz" }), { key: "ArrowUp" });
      expect(gains()[5]).toBe(0.5);
      expect(useSettings.getState().eqPresetId).toBeNull();
      expect(presetTrigger()).toHaveTextContent("Custom curve");
    });

    it("saves, updates, renames and deletes custom presets", async () => {
      renderEqualizer();
      fireEvent.keyDown(screen.getByRole("slider", { name: "250 Hz" }), { key: "PageUp" });
      fireEvent.click(screen.getByRole("button", { name: "Save as new preset" }));
      let dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Warm" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      const [saved] = useSettings.getState().customPresets;
      expect(saved?.name).toBe("Warm");
      expect(saved?.dsp.eq.mode).toMatchObject({ type: "graphic", bands: "ten" });
      expect(useSettings.getState().eqPresetId).toBe(saved?.id);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Changing the curve keeps the custom preset selected and marks it as changed.
      fireEvent.keyDown(screen.getByRole("slider", { name: "250 Hz" }), { key: "ArrowDown" });
      expect(useSettings.getState().eqPresetId).toBe(saved?.id);
      expect(presetTrigger()).toHaveTextContent("Warm (changed)");
      fireEvent.click(screen.getByRole("button", { name: "Save changes to this preset" }));
      expect(useSettings.getState().customPresets[0]?.dsp.eq.mode).toMatchObject({
        gainsDb: expect.arrayContaining([2.5]),
      });

      fireEvent.click(screen.getByRole("button", { name: "Rename preset" }));
      dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Cozy" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
      expect(useSettings.getState().customPresets[0]?.name).toBe("Cozy");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
      dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete preset" }));
      expect(useSettings.getState().customPresets).toHaveLength(0);
      expect(useSettings.getState().eqPresetId).toBeNull();
    });

    it("imports presets from pasted JSON and rejects other text", async () => {
      renderEqualizer();
      fireEvent.click(screen.getByRole("button", { name: "Share preset" }));
      const dialog = await screen.findByRole("dialog");
      const box = within(dialog).getByLabelText("Preset text") as HTMLTextAreaElement;
      // The dialog starts with the current sound as JSON.
      const exported = box.value;
      expect(JSON.parse(exported)).toMatchObject({ navify: "eq-preset", version: 1 });

      fireEvent.change(box, { target: { value: "hello" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("not a valid preset");
      expect(useSettings.getState().customPresets).toHaveLength(0);

      fireEvent.change(box, { target: { value: exported.replace('"name": ""', '"name": "From a friend"') } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
      await waitFor(() => expect(useSettings.getState().customPresets).toHaveLength(1));
      expect(useSettings.getState().customPresets[0]?.name).toBe("From a friend");
    });
  });

  describe("graphic modes", () => {
    it("moves a band with the keyboard in 0.5 dB steps and resets it on double-click", () => {
      renderEqualizer();
      const band = screen.getByRole("slider", { name: "1 kHz" });
      fireEvent.keyDown(band, { key: "ArrowUp" });
      fireEvent.keyDown(band, { key: "ArrowUp" });
      expect(gains()[5]).toBe(1);
      expect(band).toHaveAttribute("aria-valuenow", "1");
      fireEvent.keyDown(band, { key: "End" });
      expect(gains()[5]).toBe(-12);
      fireEvent.keyDown(band, { key: "ArrowDown" });
      expect(gains()[5]).toBe(-12);
      fireEvent.doubleClick(band);
      expect(gains()[5]).toBe(0);
    });

    it("converts the curve when switching between 10 and 31 bands and back", () => {
      useSettings.getState().updateDsp((dsp) => ({
        ...dsp,
        eq: {
          ...dsp.eq,
          mode: { type: "graphic", bands: "ten", gainsDb: [4, 3, 2, 1, 0, -1, -2, -3, -4, -5] },
        },
      }));
      renderEqualizer();
      fireEvent.click(screen.getByRole("tab", { name: "31 bands" }));
      const mode = eq().mode;
      expect(mode).toMatchObject({ type: "graphic", bands: "thirtyOne" });
      expect(mode.type === "graphic" && mode.gainsDb).toHaveLength(31);
      expect(screen.getAllByRole("slider", { name: /Hz$|kHz$/ })).toHaveLength(31);
      fireEvent.click(screen.getByRole("tab", { name: "10 bands" }));
      expect(gains()).toEqual([4, 3, 2, 1, 0, -1, -2, -3, -4, -5]);
    });

    it("resets the curve, the preamp and the headroom mode", () => {
      renderEqualizer();
      fireEvent.keyDown(screen.getByRole("slider", { name: "2 kHz" }), { key: "Home" });
      fireEvent.keyDown(screen.getByRole("slider", { name: "Preamp" }), { key: "ArrowLeft" });
      fireEvent.click(screen.getByRole("switch", { name: "Automatic headroom" }));
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      expect(gains().every((g) => g === 0)).toBe(true);
      expect(eq().preampDb).toBe(0);
      expect(eq().autoHeadroom).toBe(true);
    });
  });

  describe("parametric mode", () => {
    function openParametric() {
      renderEqualizer();
      fireEvent.click(screen.getByRole("tab", { name: "Parametric" }));
    }

    it("starts with neutral filters and keeps its own list when switching away and back", () => {
      openParametric();
      const mode = eq().mode;
      expect(mode.type).toBe("parametric");
      expect(mode.type === "parametric" && mode.filters).toHaveLength(5);

      fireEvent.change(screen.getByLabelText("Filter 3 gain in dB"), { target: { value: "4.5" } });
      fireEvent.click(screen.getByRole("tab", { name: "10 bands" }));
      expect(eq().mode.type).toBe("graphic");
      fireEvent.click(screen.getByRole("tab", { name: "Parametric" }));
      const back = eq().mode;
      expect(back.type === "parametric" && back.filters[2]?.gainDb).toBe(4.5);
    });

    it("builds the filters from the graphic curve the first time", () => {
      useSettings.getState().updateDsp((dsp) => ({
        ...dsp,
        eq: { ...dsp.eq, mode: { type: "graphic", bands: "ten", gainsDb: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0] } },
      }));
      openParametric();
      const mode = eq().mode;
      const filters = mode.type === "parametric" ? mode.filters : [];
      // The graphic EQ solves band interaction, so the neighbours of a +6 dB band get small cuts and the
      // band itself a little more than its slider value. The filters keep the sound identical.
      const centerFilter = filters.find((f) => f.freqHz === 1000);
      expect(centerFilter).toMatchObject({ kind: "peaking", enabled: true });
      expect(centerFilter?.gainDb).toBeGreaterThan(6);
      expect(filters.filter((f) => f.freqHz !== 1000).every((f) => f.gainDb < 0)).toBe(true);
      expect(filters.length).toBeLessThanOrEqual(5);
    });

    it("edits filters in the table and adds and removes filters (max 16)", () => {
      openParametric();
      fireEvent.change(screen.getByLabelText("Filter 1 type"), { target: { value: "lowShelf" } });
      fireEvent.change(screen.getByLabelText("Filter 1 frequency in Hz"), { target: { value: "120" } });
      fireEvent.change(screen.getByLabelText("Filter 1 Q"), { target: { value: "0.7" } });
      const filters = () => {
        const mode = eq().mode;
        return mode.type === "parametric" ? mode.filters : [];
      };
      expect(filters()[0]).toMatchObject({ kind: "lowShelf", freqHz: 120, q: 0.7 });

      fireEvent.click(screen.getByRole("switch", { name: "Filter 2 on" }));
      expect(filters()[1]?.enabled).toBe(false);

      for (let i = 0; i < 20; i++) {
        const add = screen.getByRole("button", { name: "Add filter" });
        if (!(add as HTMLButtonElement).disabled) fireEvent.click(add);
      }
      expect(filters()).toHaveLength(16);
      expect(screen.getByRole("button", { name: "Add filter" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Remove filter 16" }));
      expect(filters()).toHaveLength(15);
    });

    it("ignores the gain of pass filters", () => {
      openParametric();
      fireEvent.change(screen.getByLabelText("Filter 1 type"), { target: { value: "highPass" } });
      expect(screen.getByLabelText("Filter 1 gain in dB")).toBeDisabled();
    });

    it("moves a point with the keyboard and changes Q with the mouse wheel", () => {
      openParametric();
      const point = screen.getByRole("slider", { name: "Filter 3" });
      fireEvent.keyDown(point, { key: "ArrowUp" });
      fireEvent.keyDown(point, { key: "ArrowRight" });
      fireEvent.wheel(point, { deltaY: -100 });
      const mode = eq().mode;
      const filter = mode.type === "parametric" ? mode.filters[2] : undefined;
      expect(filter?.gainDb).toBe(0.5);
      expect(filter?.freqHz).toBeGreaterThan(1000);
      expect(filter?.q).toBeGreaterThan(1);
    });

    it("imports an AutoEQ profile through the engine and switches to parametric mode", async () => {
      const imported: EqConfig = {
        enabled: false,
        preampDb: -6.2,
        autoHeadroom: false,
        mode: {
          type: "parametric",
          filters: [{ enabled: true, kind: "lowShelf", freqHz: 105, gainDb: 5.5, q: 0.7 }],
        },
      };
      engine.parseAutoEq.mockResolvedValue(imported);
      renderEqualizer();
      fireEvent.click(screen.getByRole("button", { name: "Import AutoEQ profile" }));
      const dialog = await screen.findByRole("dialog");
      const text = "Preamp: -6.2 dB\nFilter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70";
      fireEvent.change(within(dialog).getByLabelText("Profile text"), { target: { value: text } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));

      await waitFor(() => expect(engine.parseAutoEq).toHaveBeenCalledWith(text));
      await waitFor(() => expect(eq().mode.type).toBe("parametric"));
      expect(eq()).toMatchObject({ enabled: true, preampDb: -6.2, autoHeadroom: false });
      expect(useSettings.getState().eqPresetId).toBeNull();
      expect(screen.getByLabelText("Filter 1 frequency in Hz")).toHaveValue(105);
    });

    it("shows the engine's error when the import fails (browser preview)", async () => {
      engine.parseAutoEq.mockRejectedValue(new Error("AutoEQ import needs the desktop app"));
      renderEqualizer();
      fireEvent.click(screen.getByRole("button", { name: "Import AutoEQ profile" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Profile text"), { target: { value: "Preamp: -3 dB" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Import failed: AutoEQ import needs the desktop app",
      );
      expect(eq().mode.type).toBe("graphic");
    });

    it("fills the profile text from a chosen file", async () => {
      renderEqualizer();
      fireEvent.click(screen.getByRole("button", { name: "Import AutoEQ profile" }));
      const dialog = await screen.findByRole("dialog");
      const file = new File(["Preamp: -2 dB"], "ParametricEQ.txt", { type: "text/plain" });
      Object.defineProperty(file, "text", { value: async () => "Preamp: -2 dB" });
      fireEvent.change(within(dialog).getByLabelText("Profile file"), { target: { files: [file] } });
      await waitFor(() => expect(within(dialog).getByLabelText("Profile text")).toHaveValue("Preamp: -2 dB"));
    });
  });

  describe("preamp, bass and options", () => {
    it("shows the effective preamp from the engine response", async () => {
      engine.eqResponse.mockResolvedValue({
        frequencies: [20, 20_000],
        magnitudeDb: [-5.5, -5.5],
        maxBoostDb: 5.5,
        effectivePreampDb: -5.5,
      } as never);
      useSettings.getState().updateDsp((dsp) => ({ ...dsp, eq: { ...dsp.eq, enabled: true } }));
      renderEqualizer();
      await waitFor(() => expect(screen.getByTestId("effective-preamp")).toHaveTextContent("−5.5 dB"));
    });

    it("falls back to the local response when the engine returns nothing", () => {
      useSettings.getState().updateDsp((dsp) => ({
        ...dsp,
        eq: {
          ...dsp.eq,
          enabled: true,
          mode: { type: "graphic", bands: "ten", gainsDb: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0] },
        },
      }));
      renderEqualizer();
      // Auto headroom takes back the boost, even without the engine.
      expect(screen.getByTestId("effective-preamp").textContent).toMatch(/^−[6-7]\.\d dB$/);
    });

    it("changes the preamp and the headroom mode", () => {
      renderEqualizer();
      const preamp = screen.getByRole("slider", { name: "Preamp" });
      fireEvent.keyDown(preamp, { key: "ArrowRight" });
      fireEvent.keyDown(preamp, { key: "ArrowRight" });
      expect(eq().preampDb).toBe(1);
      fireEvent.click(screen.getByRole("switch", { name: "Automatic headroom" }));
      expect(eq().autoHeadroom).toBe(false);
    });

    it("controls the bass enhancer, loudness compensation and the limiter", () => {
      renderEqualizer();
      const bass = () => useSettings.getState().dsp.bass;
      expect(screen.getByRole("slider", { name: "Boost" }).closest("[inert]")).not.toBeNull();
      fireEvent.click(screen.getByRole("switch", { name: "Deep Bass" }));
      expect(bass().enabled).toBe(true);
      expect(screen.getByRole("slider", { name: "Boost" }).closest("[inert]")).toBeNull();
      fireEvent.keyDown(screen.getByRole("slider", { name: "Boost" }), { key: "ArrowRight" });
      expect(bass().boostDb).toBe(6.5);
      fireEvent.keyDown(screen.getByRole("slider", { name: "Frequency" }), { key: "ArrowRight" });
      expect(bass().frequencyHz).toBe(81);
      fireEvent.keyDown(screen.getByRole("slider", { name: "Harmonics" }), { key: "ArrowRight" });
      expect(bass().harmonics).toBeCloseTo(0.35, 5);

      fireEvent.click(screen.getByRole("switch", { name: "Loudness compensation" }));
      expect(useSettings.getState().dsp.loudnessCompensation).toBe(true);
      expect(useSettings.getState().dsp.limiter).toBe(false);
      fireEvent.click(screen.getByRole("switch", { name: "Limiter" }));
      expect(useSettings.getState().dsp.limiter).toBe(true);
    });
  });

  describe("A/B comparison", () => {
    it("bypasses the EQ without touching the curve and comes back", () => {
      renderEqualizerWithRock();
      const compare = screen.getByRole("button", { name: "A/B" });
      expect(compare).toBeEnabled();
      const curve = eq().mode;

      fireEvent.click(compare);
      expect(eq().enabled).toBe(false);
      expect(eq().mode).toEqual(curve);
      expect(compare).toHaveAttribute("aria-pressed", "true");
      // The power switch keeps showing the intent while comparing.
      expect(screen.getByRole("switch", { name: "Equalizer on or off" })).toHaveAttribute(
        "aria-checked",
        "true",
      );

      fireEvent.click(compare);
      expect(eq().enabled).toBe(true);
      expect(compare).toHaveAttribute("aria-pressed", "false");
    });

    it("is not available while the EQ is off", () => {
      renderEqualizer();
      expect(screen.getByRole("button", { name: "A/B" })).toBeDisabled();
    });

    it("restores the EQ when leaving the page during a comparison", () => {
      const { unmount } = renderEqualizerWithRock();
      fireEvent.click(screen.getByRole("button", { name: "A/B" }));
      expect(eq().enabled).toBe(false);
      unmount();
      expect(eq().enabled).toBe(true);
    });
  });
});

/** Renders the page with the Rock preset applied (which also switches the EQ on). */
function renderEqualizerWithRock() {
  const result = renderEqualizer();
  choosePreset("Rock");
  return result;
}

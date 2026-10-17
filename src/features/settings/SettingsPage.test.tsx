import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLayout } from "@/app/layout/layoutStore";
import i18n from "@/i18n";
import type { DeviceInfo } from "@/player/engineTypes";
import { useLanguage } from "@/settings/language";
import { DEFAULT_DSP, useSettings } from "@/settings/store";
import { renderPage } from "@/test/renderPage";
import { SettingsPage } from "./SettingsPage";

const devices = vi.hoisted((): { list: DeviceInfo[] } => ({ list: [] }));
const engine = vi.hoisted(() => ({
  send: vi.fn(),
  subscribe: vi.fn(),
  subscribeSpectrum: vi.fn(),
  devices: vi.fn(),
  eqResponse: vi.fn(async () => null),
  parseAutoEq: vi.fn(),
}));
vi.mock("@/player/engine", () => ({ audioEngine: () => engine }));

const speakers: DeviceInfo = {
  id: "spk",
  name: "Desk speakers",
  isDefault: true,
  defaultSampleRate: 48000,
  maxChannels: 2,
  supportsExclusive: true,
};
const dac: DeviceInfo = {
  id: "dac",
  name: "USB DAC",
  isDefault: false,
  defaultSampleRate: 192000,
  maxChannels: 2,
  supportsExclusive: false,
};

beforeEach(() => {
  devices.list = [dac, speakers];
  engine.devices.mockImplementation(async () => devices.list);
  useSettings.setState({
    streamingQuality: "original",
    downloadQuality: "original",
    normalization: { mode: "off", target: "normal", preventClipping: true, analyzeUntagged: true },
    crossfade: { durationMs: 0, skipSameAlbum: true },
    dsp: structuredClone(DEFAULT_DSP),
    output: { deviceId: null, exclusive: false },
    accent: "purple",
  });
  useLayout.setState({ zoom: 1 });
});

afterEach(async () => {
  useLanguage.setState({ language: null });
  await i18n.changeLanguage("en");
});

const renderSettings = () => renderPage(<SettingsPage />, { path: "/settings", url: "/settings" });
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

describe("SettingsPage", () => {
  it("has a section for audio quality, playback, output and appearance", () => {
    renderSettings();
    for (const name of ["Audio quality", "Playback", "Output", "Appearance"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("changes streaming and download quality independently", () => {
    renderSettings();
    expect(radio("Streaming quality", "Original")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(radio("Streaming quality", "Normal"));
    fireEvent.click(radio("Download quality", "Low"));
    expect(useSettings.getState().streamingQuality).toBe("normal");
    expect(useSettings.getState().downloadQuality).toBe("low");
    expect(radio("Streaming quality", "Normal")).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText(/up to 192 kbit\/s/).length).toBeGreaterThan(0);
  });

  it("moves the radio selection with the arrow keys", () => {
    renderSettings();
    const group = screen.getByRole("radiogroup", { name: "Streaming quality" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(useSettings.getState().streamingQuality).toBe("high");
  });

  it("sets the crossfade in seconds and only offers the album option while it is on", () => {
    renderSettings();
    const skip = screen.getByRole("switch", { name: "Do not crossfade within an album" });
    expect(skip).toBeDisabled();
    const slider = screen.getByRole("slider", { name: "Crossfade" });
    expect(slider).toHaveAttribute("aria-valuetext", "Off");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(useSettings.getState().crossfade.durationMs).toBe(2000);
    expect(screen.getByRole("slider", { name: "Crossfade" })).toHaveAttribute("aria-valuetext", "2 s");
    expect(skip).toBeEnabled();
    fireEvent.click(skip);
    expect(useSettings.getState().crossfade.skipSameAlbum).toBe(false);
  });

  it("configures volume leveling: mode, target and clipping protection", () => {
    renderSettings();
    expect(radio("Loudness target", "Normal")).toBeDisabled();
    fireEvent.click(radio("Volume leveling", "Album"));
    fireEvent.click(radio("Loudness target", "Quiet"));
    fireEvent.click(screen.getByRole("switch", { name: "Prevent clipping" }));
    expect(useSettings.getState().normalization).toEqual({
      mode: "album",
      target: "quiet",
      preventClipping: false,
      analyzeUntagged: true,
    });
  });

  it("sets mono, balance and stereo width in the DSP settings", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("switch", { name: "Mono" }));
    expect(useSettings.getState().dsp.stereo.mono).toBe(true);
    const balance = screen.getByRole("slider", { name: "Balance" });
    expect(balance).toHaveAttribute("aria-valuetext", "Center");
    fireEvent.keyDown(balance, { key: "ArrowLeft" });
    expect(useSettings.getState().dsp.stereo.balance).toBeCloseTo(-0.01, 5);
    expect(balance).toHaveAttribute("aria-valuetext", "Left 1 %");
    fireEvent.doubleClick(balance);
    expect(useSettings.getState().dsp.stereo.balance).toBe(0);

    fireEvent.click(screen.getByRole("switch", { name: "Mono" }));
    const width = screen.getByRole("slider", { name: "Stereo width" });
    fireEvent.keyDown(width, { key: "ArrowRight" });
    expect(useSettings.getState().dsp.stereo.width).toBeCloseTo(1.05, 5);
  });

  it("links to the equalizer", async () => {
    const { router } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Open equalizer" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/equalizer"));
  });

  it("selects the output device from the engine list and switches exclusive mode", async () => {
    renderSettings();
    const select = screen.getByRole("combobox", { name: "Output device" });
    await waitFor(() => expect(within(select).getByRole("option", { name: "USB DAC" })).toBeInTheDocument());
    expect(within(select).getByRole("option", { name: "System default" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "spk" } });
    expect(useSettings.getState().output.deviceId).toBe("spk");
    const exclusive = screen.getByRole("switch", { name: "Exclusive mode" });
    expect(exclusive).toBeEnabled();
    fireEvent.click(exclusive);
    expect(useSettings.getState().output.exclusive).toBe(true);

    // A device without exclusive support disables the switch and says why.
    fireEvent.change(select, { target: { value: "dac" } });
    expect(exclusive).toBeDisabled();
    expect(screen.getByText("This device does not support exclusive mode.")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "" } });
    expect(useSettings.getState().output.deviceId).toBeNull();
  });

  it("explains when exclusive mode gives bit-perfect output", () => {
    renderSettings();
    expect(screen.getByText(/Bit-perfect output needs exclusive mode/)).toBeInTheDocument();
  });

  it("switches the accent between colors and gradients", () => {
    renderSettings();
    for (const [group, name, accent] of [
      ["Colors", "Blue", "blue"],
      ["Gradients", "Sunset", "sunset"],
      ["Colors", "Purple", "purple"],
    ] as const) {
      fireEvent.click(radio(group, name));
      expect(useSettings.getState().accent).toBe(accent);
      expect(radio(group, name)).toHaveAttribute("aria-checked", "true");
    }
    expect(screen.queryByRole("radio", { name: "Dynamic" })).not.toBeInTheDocument();
  });

  it("sets the zoom in steps from 70 to 130 percent", () => {
    renderSettings();
    const labels = within(screen.getByRole("radiogroup", { name: "Zoom" }))
      .getAllByRole("radio")
      .map((r) => r.textContent);
    expect(labels).toEqual(["70 %", "80 %", "90 %", "100 %", "110 %", "120 %", "130 %"]);
    fireEvent.click(radio("Zoom", "80 %"));
    expect(useLayout.getState().zoom).toBe(0.8);
    expect(radio("Zoom", "80 %")).toHaveAttribute("aria-checked", "true");
  });

  it("changes the language, translates the page and remembers the choice", async () => {
    renderSettings();
    const picker = screen.getByRole("combobox", { name: "Language" });
    expect(picker).toHaveValue("en");
    // Every language is listed by its own name.
    expect(within(picker).getByRole("option", { name: "日本語" })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "de" } });
    expect(useLanguage.getState().language).toBe("de");
    expect(await screen.findByRole("heading", { level: 1, name: "Einstellungen" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Audioqualität" })).toBeInTheDocument();
    expect(screen.getByText("Innerhalb eines Albums nicht überblenden")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Ausgabe" })).toBeInTheDocument();
  });
});

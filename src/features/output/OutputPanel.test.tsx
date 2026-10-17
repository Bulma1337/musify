import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLayout } from "@/app/layout/layoutStore";
import { useEngineStatus } from "@/player/bridge";
import type { DeviceInfo, OutputFormat, SourceFormat } from "@/player/engineTypes";
import { usePlayer } from "@/player/store";
import { DEFAULT_DSP, useSettings } from "@/settings/store";
import { renderPage } from "@/test/renderPage";
import { OutputPanel } from "./OutputPanel";
import {
  activeProcessing,
  bitPerfectBlockers,
  formatOutputFormat,
  formatSampleRate,
  formatSourceFormat,
} from "./signalPath";
import { sortDevices } from "./useOutputDevices";

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
  name: "Sound Blaster X5",
  isDefault: false,
  defaultSampleRate: 192000,
  maxChannels: 2,
  supportsExclusive: false,
};

const flac: SourceFormat = {
  codec: "flac",
  sampleRate: 96000,
  bitsPerSample: 24,
  channels: 2,
  bitrateKbps: 2800,
  lossless: true,
};
const mp3: SourceFormat = {
  codec: "mp3",
  sampleRate: 44100,
  bitsPerSample: null,
  channels: 2,
  bitrateKbps: 320,
  lossless: false,
};
const exclusiveOut: OutputFormat = {
  deviceName: "Sound Blaster X5",
  sampleRate: 192000,
  channels: 2,
  exclusive: true,
  bitPerfect: true,
};
const sharedOut: OutputFormat = { ...exclusiveOut, sampleRate: 48000, exclusive: false, bitPerfect: false };

beforeEach(() => {
  engine.devices.mockImplementation(async () => [dac, speakers]);
  useEngineStatus.setState({ sourceFormat: null, outputFormat: null });
  useSettings.setState({
    dsp: structuredClone(DEFAULT_DSP),
    output: { deviceId: null, exclusive: false },
    normalization: { mode: "off", target: "normal", preventClipping: true, analyzeUntagged: true },
  });
  usePlayer.setState({ volume: 1, muted: false });
});

const renderPanel = () => renderPage(<OutputPanel />, { path: "/", url: "/" });

describe("OutputPanel", () => {
  it("shows the bit-perfect badge and the signal path from source to device", () => {
    useEngineStatus.setState({ sourceFormat: flac, outputFormat: exclusiveOut });
    renderPanel();
    expect(screen.getByTestId("bit-perfect-badge")).toHaveTextContent("Bit-perfect");
    expect(screen.getByText("FLAC · 24 Bit · 96 kHz")).toBeInTheDocument();
    expect(screen.getByText("Sound Blaster X5 · 192 kHz · exclusive")).toBeInTheDocument();
    expect(screen.getByText("None, signal unchanged")).toBeInTheDocument();
    expect(screen.queryByText("Not bit-perfect")).not.toBeInTheDocument();
  });

  it("shows no badge but the likely reasons when the output is not bit-perfect", () => {
    useEngineStatus.setState({ sourceFormat: mp3, outputFormat: sharedOut });
    useSettings.getState().updateDsp((d) => ({ ...d, eq: { ...d.eq, enabled: true } }));
    usePlayer.setState({ volume: 0.5 });
    renderPanel();
    expect(screen.queryByTestId("bit-perfect-badge")).not.toBeInTheDocument();
    expect(screen.getByText("Not bit-perfect")).toBeInTheDocument();
    expect(screen.getByText("MP3 · 320 kbit/s · 44.1 kHz")).toBeInTheDocument();
    expect(screen.getByText("Sound Blaster X5 · 48 kHz · shared")).toBeInTheDocument();
    for (const reason of [
      "The equalizer is on.",
      "The device is used in shared mode.",
      "The volume is below 100 %.",
      "The sample rate of the track differs from the device.",
    ]) {
      expect(screen.getByText(reason)).toBeInTheDocument();
    }
    expect(screen.getByText("Equalizer")).toBeInTheDocument();
  });

  it("asks to play something while the engine reports nothing yet", () => {
    renderPanel();
    expect(screen.getAllByText("Nothing is playing")).toHaveLength(2);
    expect(screen.queryByTestId("bit-perfect-badge")).not.toBeInTheDocument();
  });

  it("lists the system default first, then the default device, then the others, and selects one", async () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Devices" });
    await waitFor(() => expect(within(group).getAllByRole("radio")).toHaveLength(3));
    const names = within(group)
      .getAllByRole("radio")
      .map((r) => r.textContent);
    expect(names[0]).toContain("System default");
    expect(names[0]).toContain("Desk speakers");
    expect(names[1]).toContain("Desk speakers");
    expect(names[1]).toContain("Default");
    expect(names[2]).toContain("Sound Blaster X5");
    expect(within(group).getAllByRole("radio")[0]).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(group).getByRole("radio", { name: /Sound Blaster X5/ }));
    expect(useSettings.getState().output.deviceId).toBe("dac");
    expect(within(group).getByRole("radio", { name: /Sound Blaster X5/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("refreshes the device list on demand", async () => {
    renderPanel();
    await waitFor(() => expect(engine.devices).toHaveBeenCalledTimes(1));
    await screen.findByRole("radio", { name: /Desk speakers.*Default/ });
    fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
    await waitFor(() => expect(engine.devices).toHaveBeenCalledTimes(2));
  });

  it("switches exclusive mode, except for devices that cannot do it", async () => {
    renderPanel();
    const exclusive = screen.getByRole("switch", { name: "Exclusive mode" });
    await screen.findByRole("radio", { name: /Sound Blaster X5/ });
    fireEvent.click(exclusive);
    expect(useSettings.getState().output.exclusive).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Sound Blaster X5/ }));
    expect(exclusive).toBeDisabled();
    expect(screen.getByText("This device does not support exclusive mode.")).toBeInTheDocument();
  });

  it("warns when the saved device is gone", async () => {
    useSettings.setState({ output: { deviceId: "unplugged", exclusive: false } });
    renderPanel();
    expect(await screen.findByText(/saved device is not connected/)).toBeInTheDocument();
  });

  it("explains the browser preview, where the engine lists no devices", async () => {
    engine.devices.mockImplementation(async () => []);
    renderPanel();
    expect(await screen.findByText(/No devices found/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /System default/ })).toHaveAttribute("aria-checked", "true");
  });

  it("closes the panel and links to the equalizer", () => {
    useLayout.setState({ rightPanel: "devices" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useLayout.getState().rightPanel).toBeNull();
    expect(screen.getByRole("link", { name: "Open equalizer" })).toHaveAttribute("href", "/equalizer");
  });
});

describe("signal path helpers", () => {
  it("formats sample rates, sources and outputs", () => {
    expect(formatSampleRate(44100)).toBe("44.1 kHz");
    expect(formatSampleRate(96000)).toBe("96 kHz");
    expect(formatSourceFormat(flac)).toBe("FLAC · 24 Bit · 96 kHz");
    expect(formatSourceFormat(mp3)).toBe("MP3 · 320 kbit/s · 44.1 kHz");
    expect(formatOutputFormat(exclusiveOut)).toBe("Sound Blaster X5 · 192 kHz · exclusive");
    expect(formatOutputFormat(sharedOut)).toBe("Sound Blaster X5 · 48 kHz · shared");
  });

  it("lists the active processing stages", () => {
    const dsp = structuredClone(DEFAULT_DSP);
    const normalization = {
      mode: "off" as const,
      target: "normal" as const,
      preventClipping: true,
      analyzeUntagged: true,
    };
    expect(activeProcessing(dsp, normalization)).toEqual([]);
    dsp.eq.enabled = true;
    dsp.bass.enabled = true;
    dsp.stereo.balance = 0.2;
    expect(activeProcessing(dsp, { ...normalization, mode: "track" })).toEqual([
      "equalizer",
      "bass",
      "stereo",
      "normalization",
    ]);
  });

  it("finds no blockers for a clean exclusive path at full volume", () => {
    const normalization = {
      mode: "off" as const,
      target: "normal" as const,
      preventClipping: true,
      analyzeUntagged: true,
    };
    expect(
      bitPerfectBlockers({
        dsp: DEFAULT_DSP,
        normalization,
        volume: 1,
        muted: false,
        source: { ...flac, sampleRate: 192000 },
        output: exclusiveOut,
      }),
    ).toEqual([]);
  });

  it("sorts the default device first, then by name", () => {
    expect(sortDevices([dac, speakers]).map((d) => d.id)).toEqual(["spk", "dac"]);
  });
});

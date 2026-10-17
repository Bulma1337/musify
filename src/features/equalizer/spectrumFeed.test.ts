import type { SpectrumFrame } from "@/player/engineTypes";
import { listenToSpectrum } from "./spectrumFeed";

const engine = vi.hoisted(() => ({ send: vi.fn(), subscribeSpectrum: vi.fn() }));
vi.mock("@/player/engine", () => ({ audioEngine: () => engine }));

describe("listenToSpectrum", () => {
  it("opens the engine channel once, runs the analyzer only while someone listens and fans frames out", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = listenToSpectrum(a);
    expect(engine.subscribeSpectrum).toHaveBeenCalledTimes(1);
    expect(engine.send).toHaveBeenLastCalledWith({ type: "setSpectrum", enabled: true });

    const stopB = listenToSpectrum(b);
    expect(engine.send).toHaveBeenCalledTimes(1);

    const frame: SpectrumFrame = { bands: [1, 2, 3], peakDb: -3 };
    engine.subscribeSpectrum.mock.calls[0]?.[0](frame);
    expect(a).toHaveBeenCalledWith(frame);
    expect(b).toHaveBeenCalledWith(frame);

    stopA();
    expect(engine.send).toHaveBeenCalledTimes(1);
    stopB();
    expect(engine.send).toHaveBeenLastCalledWith({ type: "setSpectrum", enabled: false });

    // A later page visit reuses the channel.
    const stopC = listenToSpectrum(vi.fn());
    expect(engine.subscribeSpectrum).toHaveBeenCalledTimes(1);
    expect(engine.send).toHaveBeenLastCalledWith({ type: "setSpectrum", enabled: true });
    stopC();
  });
});

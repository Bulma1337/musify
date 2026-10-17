import capabilities from "../../src-tauri/capabilities/default.json";
import { registerShutdownTask, startCloseHandling } from "./windowClose";

describe("shutdown tasks", () => {
  it("run when the app goes away and can be removed again", async () => {
    const save = vi.fn();
    const install = vi.fn(async () => {});
    const offSave = registerShutdownTask(save);
    const offInstall = registerShutdownTask(install);
    const stop = startCloseHandling();

    window.dispatchEvent(new Event("beforeunload"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(install).toHaveBeenCalledTimes(1);

    offInstall();
    window.dispatchEvent(new Event("beforeunload"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(install).toHaveBeenCalledTimes(1);

    offSave();
    stop();
  });
});

describe("window permissions", () => {
  it("allow destroying the window, which Tauri does after every close handler", () => {
    // Without it the close button does nothing once a close handler is registered.
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });
});

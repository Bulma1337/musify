import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { registerShutdownTask } from "@/app/windowClose";
import { inTauri } from "@/lib/platform";

/**
 * In-app updates (GitHub Releases, signed `latest.json`). Checks shortly after start and every 6 h,
 * downloads a new version in the background and installs it when the user restarts from the
 * notice, or when the app is closed. Release notes come from the release body.
 */

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  "idle" | "checking" | "upToDate" | "downloading" | "ready" | "installing" | "error" | "unavailable";

interface UpdateState {
  status: UpdateStatus;
  version?: string;
  notes?: string;
  /** 0…1 while downloading (null when the size is unknown). */
  progress: number | null;
  error?: string;
  lastCheck?: number;
}

export const useUpdates = create<UpdateState>(() => ({
  status: inTauri ? "idle" : "unavailable",
  progress: null,
}));

let pending: Update | null = null;
let busy = false;

/**
 * Checks for a new version and downloads it in the background. Background checks stay quiet when
 * something fails (offline, no release published yet); a check the user started reports it.
 */
export async function checkForUpdate({ manual = false }: { manual?: boolean } = {}): Promise<void> {
  if (!inTauri || busy) return;
  const state = useUpdates.getState().status;
  if (state === "ready" || state === "installing") return;
  busy = true;
  useUpdates.setState({ status: "checking", error: undefined, lastCheck: Date.now() });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      useUpdates.setState({ status: "upToDate" });
      return;
    }
    useUpdates.setState({
      status: "downloading",
      version: update.version,
      notes: update.body,
      progress: 0,
    });
    let total = 0;
    let received = 0;
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        useUpdates.setState({ progress: total > 0 ? Math.min(received / total, 1) : null });
      }
    });
    pending = update;
    useUpdates.setState({ status: "ready", progress: 1 });
  } catch (error) {
    useUpdates.setState(manual ? { status: "error", error: String(error) } : { status: "idle" });
  } finally {
    busy = false;
  }
}

/** Installs the downloaded update; the installer closes the app and starts the new version. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  useUpdates.setState({ status: "installing" });
  try {
    await pending.install();
  } catch (error) {
    useUpdates.setState({ status: "error", error: String(error) });
  }
}

/** Automatic checks (if enabled) and install-on-close. Returns cleanup. */
export function startUpdateChecks(enabled: () => boolean): () => void {
  if (!inTauri) return () => {};
  const first = setTimeout(() => enabled() && void checkForUpdate(), FIRST_CHECK_DELAY_MS);
  const every = setInterval(() => enabled() && void checkForUpdate(), CHECK_EVERY_MS);
  // A downloaded update is installed when the app closes (the installer runs silently).
  const unregister = registerShutdownTask(async () => {
    if (pending && useUpdates.getState().status === "ready") await installUpdate();
  });
  return () => {
    clearTimeout(first);
    clearInterval(every);
    unregister();
  };
}

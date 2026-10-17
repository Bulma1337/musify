import { inTauri } from "@/lib/platform";
import { useSettings } from "@/settings/store";

/**
 * The one place that handles closing the window. Tauri closes the window as soon as any close
 * listener returns without preventing it, so features register shutdown tasks here instead of
 * listening themselves. With "keep running in the tray" closing only hides the window; "quit" from
 * the tray menu really closes it (after the tasks ran).
 */

type Task = () => Promise<void> | void;

const tasks = new Set<Task>();
let quitting = false;
/** Longest wait for shutdown tasks (saving the queue, starting an update). */
const SHUTDOWN_TIMEOUT_MS = 2_000;

/** Runs `task` when the app really closes. Returns a function that removes it again. */
export function registerShutdownTask(task: Task): () => void {
  tasks.add(task);
  return () => tasks.delete(task);
}

async function runTasks() {
  await Promise.race([
    Promise.allSettled([...tasks].map(async (task) => task())),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
}

/** Quits the app (tray menu): runs the shutdown tasks, then closes the window. */
export async function requestQuit() {
  quitting = true;
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export function startCloseHandling(): () => void {
  if (!inTauri) {
    const onUnload = () => void runTasks();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }
  let unlistenClose: (() => void) | undefined;
  let unlistenQuit: (() => void) | undefined;
  void Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/event")]).then(
    ([{ getCurrentWindow }, { listen }]) => {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (event) => {
          if (!quitting && useSettings.getState().closeToTray) {
            event.preventDefault();
            await win.hide();
            return;
          }
          await runTasks();
        })
        .then((off) => {
          unlistenClose = off;
        });
      void listen("app-quit", () => void requestQuit()).then((off) => {
        unlistenQuit = off;
      });
    },
  );
  return () => {
    unlistenClose?.();
    unlistenQuit?.();
  };
}

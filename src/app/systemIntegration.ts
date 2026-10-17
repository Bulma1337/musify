import i18n from "@/i18n";
import { inTauri } from "@/lib/platform";
import { usePlayer, type PlayerState } from "@/player/store";
import { useSettings } from "@/settings/store";

/**
 * Tray menu texts and state (play/pause, tooltip with the current track) and desktop notifications
 * on track changes while the app is in the background.
 */

/** Windows limits tray tooltips to 127 characters. */
const MAX_TOOLTIP = 120;

function trackLine(s: PlayerState): string {
  const track = s.current?.track;
  if (!track) return "Musify";
  const line = `${track.title} – ${track.artistLine}`;
  return line.length > MAX_TOOLTIP ? `${line.slice(0, MAX_TOOLTIP - 1)}…` : line;
}

async function updateTray(s: PlayerState) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("tray_update", {
    labels: {
      open: i18n.t("tray.open"),
      play: i18n.t("player.play"),
      pause: i18n.t("player.pause"),
      next: i18n.t("player.next"),
      previous: i18n.t("player.previous"),
      quit: i18n.t("tray.quit"),
    },
    playing: s.isPlaying,
    hasTrack: !!s.current,
    tooltip: trackLine(s),
  }).catch(() => {});
}

async function notifyTrack(s: PlayerState) {
  const track = s.current?.track;
  if (!track) return;
  const { isPermissionGranted, requestPermission, sendNotification } =
    await import("@tauri-apps/plugin-notification");
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title: track.title, body: track.artistLine });
}

export function startSystemIntegration(): () => void {
  if (!inTauri) return () => {};
  void updateTray(usePlayer.getState());
  const unsubscribe = usePlayer.subscribe((s, prev) => {
    const trackChanged = s.current?.key !== prev.current?.key;
    if (trackChanged || s.isPlaying !== prev.isPlaying) void updateTray(s);
    const inBackground = document.visibilityState === "hidden" || !document.hasFocus();
    if (trackChanged && s.isPlaying && inBackground && useSettings.getState().notifyTrackChange) {
      void notifyTrack(s);
    }
  });
  const onLanguage = () => void updateTray(usePlayer.getState());
  i18n.on("languageChanged", onLanguage);
  return () => {
    unsubscribe();
    i18n.off("languageChanged", onLanguage);
  };
}

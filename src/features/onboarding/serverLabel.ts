import type { ServerProbe } from "@/api/provider";

const SERVER_LABELS: Record<string, string> = {
  navidrome: "Navidrome",
  gonic: "Gonic",
  airsonic: "Airsonic",
  "airsonic-advanced": "Airsonic-Advanced",
  ampache: "Ampache",
  lms: "LMS",
  jellyfin: "Jellyfin",
};

/** "Navidrome 0.64.2" for the detection hint. */
export function serverLabel(probe: ServerProbe): string {
  const type = probe.serverType;
  const name = (type && SERVER_LABELS[type.toLowerCase()]) ?? type ?? "Subsonic";
  // Navidrome reports e.g. "0.64.2 (10114574)"; the build hash in parentheses is noise for users.
  const version = probe.serverVersion?.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return version ? `${name} ${version}` : name;
}

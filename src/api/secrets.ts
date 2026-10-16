import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform";

/**
 * Server secrets live in the OS credential store (via Rust). The browser preview has no keyring,
 * so it falls back to sessionStorage, which is cleared when the tab closes.
 */
const DEV_PREFIX = "navify.dev-secret.";

export async function saveSecret(serverId: string, secret: string): Promise<void> {
  if (inTauri) return invoke("secret_set", { serverId, secret });
  sessionStorage.setItem(DEV_PREFIX + serverId, secret);
}

export async function loadSecret(serverId: string): Promise<string | null> {
  if (inTauri) return invoke<string | null>("secret_get", { serverId });
  return sessionStorage.getItem(DEV_PREFIX + serverId);
}

export async function deleteSecret(serverId: string): Promise<void> {
  if (inTauri) return invoke("secret_delete", { serverId });
  sessionStorage.removeItem(DEV_PREFIX + serverId);
}

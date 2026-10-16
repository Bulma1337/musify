import { load, type Store } from "@tauri-apps/plugin-store";
import { inTauri } from "@/lib/platform";

/**
 * Small JSON key/value persistence for app settings and server configs (never secrets).
 * Tauri: plugin-store files in the app config dir. Browser preview: localStorage.
 */
const stores = new Map<string, Promise<Store>>();

function storeFile(file: string): Promise<Store> {
  let store = stores.get(file);
  if (!store) {
    store = load(file, { defaults: {}, autoSave: 200 });
    stores.set(file, store);
  }
  return store;
}

export async function readPersisted<T>(file: string, key: string): Promise<T | undefined> {
  if (inTauri) return (await storeFile(file)).get<T>(key);
  const raw = localStorage.getItem(`navify.${file}.${key}`);
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function writePersisted<T>(file: string, key: string, value: T): Promise<void> {
  if (inTauri) {
    await (await storeFile(file)).set(key, value);
    return;
  }
  localStorage.setItem(`navify.${file}.${key}`, JSON.stringify(value));
}

import { isTauri } from "@tauri-apps/api/core";

/**
 * True when running inside the Tauri shell. False in the plain Vite dev server
 * (browser preview), where native commands are mocked or skipped.
 */
export const inTauri: boolean = isTauri();

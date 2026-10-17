import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { httpRequest } from "@/api/http";
import type { CoverRef, MusicProvider } from "@/api/provider";
import { inTauri } from "@/lib/platform";

/**
 * Saves a PNG: the app asks for a location with the save dialog and a small Rust command writes the
 * bytes (so no file-system permission is granted to the webview); the browser preview downloads it.
 * Returns false when the user cancelled.
 */
export async function savePng(blob: Blob, fileName: string): Promise<boolean> {
  if (inTauri) {
    const path = await save({ defaultPath: fileName, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!path) return false;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Raw body plus the path in a header: a JSON byte array would be several times larger.
    await invoke("save_png", bytes, { headers: { "x-path": encodeURIComponent(path) } });
    return true;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * Loads a cover for drawing on a canvas. Servers send no CORS headers, so the image is fetched
 * through the HTTP plugin and decoded from bytes (an <img> would taint the canvas). Null on failure.
 */
export async function loadCoverBitmap(
  provider: MusicProvider,
  cover: CoverRef | null | undefined,
): Promise<ImageBitmap | null> {
  if (!cover) return null;
  try {
    const response = await httpRequest(provider.coverUrl(cover, 600), { timeoutMs: 15_000 });
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

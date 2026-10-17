import { useSyncExternalStore } from "react";

const supported = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** True while the CSS media query matches (e.g. "(max-width: 1023px)"); false where unsupported. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!supported()) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => supported() && window.matchMedia(query).matches,
    () => false,
  );
}

/** Narrow windows (below the width where the right panel hides): the library shows as icons only. */
export const NARROW_WINDOW_QUERY = "(max-width: 1023px)";

import { createContext, useContext } from "react";

/** The main view's scroll element, used by virtualized lists and sticky page headers. */
export const ScrollContainerContext = createContext<HTMLElement | null>(null);

export function useScrollContainer(): HTMLElement | null {
  return useContext(ScrollContainerContext);
}

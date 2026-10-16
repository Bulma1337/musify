import { useEffect, useState } from "react";

const CARD_MIN_WIDTH = 176;

/**
 * Number of grid columns that fit into an element (re-computed on resize). Returns a callback ref,
 * so it also works for grids that mount later (e.g. after their data loaded).
 */
export function useGridColumns(minWidth = CARD_MIN_WIDTH) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(5);
  useEffect(() => {
    if (!element) return;
    const update = (width: number) => setColumns(Math.max(2, Math.floor(width / minWidth)));
    update(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minWidth]);
  return { ref: setElement, columns };
}

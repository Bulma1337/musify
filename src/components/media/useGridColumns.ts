import { useEffect, useRef, useState } from "react";

const CARD_MIN_WIDTH = 176;

/** Number of grid columns that fit into an element (re-computed on resize). */
export function useGridColumns(minWidth = CARD_MIN_WIDTH) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(5);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setColumns(Math.max(2, Math.floor(width / minWidth)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [minWidth]);
  return { ref, columns };
}

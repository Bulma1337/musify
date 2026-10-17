import { useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";
import { paletteGradient, type PatternKind, type RecapPalette } from "./palette";
import { patternShapes } from "./patterns";

/** The year's gradient and pattern, filling its container. Decorative. */
export function PatternBackground({
  palette,
  kind,
  year,
  still = false,
}: {
  palette: RecapPalette;
  kind: PatternKind;
  year: number;
  /** No drifting animation (small previews). */
  still?: boolean;
}) {
  const reduced = useReducedMotion() || still;
  // A tall pattern; "slice" crops it to whatever shape the stage has.
  const aspect = 1.8;
  const shapes = useMemo(() => patternShapes(kind, year, aspect), [kind, year]);
  const color = (tone: "ink" | "accent") => (tone === "ink" ? palette.ink : palette.accent);

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: paletteGradient(palette) }}
      aria-hidden
    >
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 100 ${100 * aspect}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <motion.g
          animate={reduced ? undefined : { x: [0, -2.5, 0], y: [0, 1.5, 0] }}
          transition={{ duration: 28, repeat: Infinity, ease: "easeInOut" }}
        >
          {shapes.map((shape, i) => (
            <path
              key={i}
              d={shape.d}
              fill={shape.mode === "fill" ? color(shape.tone) : "none"}
              stroke={shape.mode === "stroke" ? color(shape.tone) : "none"}
              strokeWidth={shape.width}
              strokeLinecap="round"
              opacity={shape.opacity}
            />
          ))}
        </motion.g>
      </svg>
    </div>
  );
}

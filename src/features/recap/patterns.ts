import { seededRandom } from "@/lib/random";
import type { PatternKind } from "./palette";

/**
 * Background art for the Recap. A pattern is a list of SVG path shapes in a coordinate system 100
 * units wide and `100 * aspect` tall. The same list is drawn as SVG on screen and with `Path2D` on
 * a canvas for the share images, so both look alike. Shapes are faint on purpose: text sits on top.
 */
export interface PatternShape {
  d: string;
  mode: "fill" | "stroke";
  /** Stroke width in pattern units. */
  width?: number;
  opacity: number;
  /** Which palette color the shape uses. */
  tone: "ink" | "accent";
}

const f = (n: number) => Math.round(n * 100) / 100;
const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

/** A closed smooth blob around (cx, cy). */
function blob(cx: number, cy: number, r: number, random: () => number): string {
  const points = 7;
  const radii = Array.from({ length: points }, () => r * (0.72 + random() * 0.5));
  const at = (i: number): [number, number] => {
    const angle = (i / points) * Math.PI * 2;
    return [cx + Math.cos(angle) * radii[i % points]!, cy + Math.sin(angle) * radii[i % points]!];
  };
  // Catmull-Rom to cubic Bezier through all points.
  let d = "";
  for (let i = 0; i < points; i++) {
    const p0 = at(i - 1 + points);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    if (i === 0) d += `M${f(p1[0])} ${f(p1[1])}`;
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(
      p2[1] - (p3[1] - p1[1]) / 6,
    )} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

function waves(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  const rows = 14;
  for (let i = 0; i < rows; i++) {
    const y = (h / (rows - 1)) * i;
    const amp = 2.5 + random() * 4;
    const phase = random() * 8;
    let d = `M${f(-12 + phase)} ${f(y)}`;
    for (let x = -12; x < 112; x += 12) d += `q3 ${f(-amp)} 6 0t6 0`;
    shapes.push({
      d,
      mode: "stroke",
      width: 0.7,
      opacity: i % 4 === 0 ? 0.16 : 0.09,
      tone: i % 4 === 0 ? "accent" : "ink",
    });
  }
  return shapes;
}

function rings(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  const centers = [
    [20 + random() * 20, h * (0.15 + random() * 0.2)],
    [65 + random() * 25, h * (0.65 + random() * 0.25)],
  ] as const;
  centers.forEach(([cx, cy], k) => {
    for (let i = 1; i <= 9; i++) {
      shapes.push({
        d: circle(cx, cy, i * 8 + k * 3),
        mode: "stroke",
        width: i % 3 === 0 ? 1.1 : 0.6,
        opacity: i % 3 === 0 ? 0.16 : 0.09,
        tone: i % 3 === 0 && k === 0 ? "accent" : "ink",
      });
    }
  });
  return shapes;
}

function dots(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  const step = 7.5;
  const angle = random() * Math.PI;
  for (let y = 0; y <= h + step; y += step) {
    for (let x = 0; x <= 100 + step; x += step) {
      // Radius grows along a diagonal so the field looks like a halftone gradient.
      const t = (x * Math.cos(angle) + y * Math.sin(angle)) / (100 + h);
      const r = 0.4 + Math.abs(Math.sin(t * Math.PI * 2 + 1)) * 2.2;
      shapes.push({
        d: circle(x + (Math.round(y / step) % 2) * (step / 2), y, r),
        mode: "fill",
        opacity: 0.12,
        tone: "ink",
      });
    }
  }
  return shapes;
}

function stripes(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  const slant = 25 + random() * 40;
  const gap = 17;
  for (let x = -slant - h; x < 110; x += gap) {
    shapes.push({
      d: `M${f(x)} ${f(h)}L${f(x + slant + 6)} ${f(h)}L${f(x + slant + h + 6)} 0L${f(x + h)} 0Z`,
      mode: "fill",
      opacity: 0.07,
      tone: "ink",
    });
  }
  shapes.push({
    d: `M-5 ${f(h * 0.55)}L105 ${f(h * 0.3)}`,
    mode: "stroke",
    width: 1.4,
    opacity: 0.18,
    tone: "accent",
  });
  return shapes;
}

function grid(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  const step = 12.5;
  for (let x = 0; x <= 100; x += step) {
    shapes.push({ d: `M${x} 0V${f(h)}`, mode: "stroke", width: 0.35, opacity: 0.12, tone: "ink" });
  }
  for (let y = 0; y <= h; y += step) {
    shapes.push({ d: `M0 ${f(y)}H100`, mode: "stroke", width: 0.35, opacity: 0.12, tone: "ink" });
  }
  const columns = Math.floor(100 / step);
  const rows = Math.floor(h / step);
  for (let i = 0; i < 9; i++) {
    const x = Math.floor(random() * columns) * step;
    const y = Math.floor(random() * rows) * step;
    shapes.push({
      d: `M${x} ${f(y)}h${step}v${step}h${-step}Z`,
      mode: "fill",
      opacity: i % 3 === 0 ? 0.14 : 0.06,
      tone: i % 3 === 0 ? "accent" : "ink",
    });
  }
  return shapes;
}

function blobs(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  for (let i = 0; i < 7; i++) {
    shapes.push({
      d: blob(random() * 100, random() * h, 14 + random() * 26, random),
      mode: "fill",
      opacity: i % 3 === 0 ? 0.16 : 0.07,
      tone: i % 3 === 0 ? "accent" : "ink",
    });
  }
  return shapes;
}

function triangles(h: number, random: () => number): PatternShape[] {
  const shapes: PatternShape[] = [];
  for (let i = 0; i < 26; i++) {
    const x = random() * 100;
    const y = random() * h;
    const s = 5 + random() * 14;
    const rotate = random() * Math.PI * 2;
    const points = [0, 1, 2].map((k) => {
      const a = rotate + (k * Math.PI * 2) / 3;
      return `${f(x + Math.cos(a) * s)} ${f(y + Math.sin(a) * s)}`;
    });
    const filled = i % 3 !== 0;
    shapes.push({
      d: `M${points.join("L")}Z`,
      mode: filled ? "fill" : "stroke",
      width: 0.6,
      opacity: filled ? 0.07 : 0.16,
      tone: i % 5 === 0 ? "accent" : "ink",
    });
  }
  return shapes;
}

const BUILDERS: Record<PatternKind, (h: number, random: () => number) => PatternShape[]> = {
  waves,
  rings,
  dots,
  stripes,
  grid,
  blobs,
  triangles,
};

/** Shapes of a pattern for a canvas `aspect` (height / width) and a year-specific variation. */
export function patternShapes(kind: PatternKind, year: number, aspect: number): PatternShape[] {
  return BUILDERS[kind](100 * aspect, seededRandom(year * 7919 + kind.length));
}

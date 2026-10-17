import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import type { EqConfig, EqResponse, ParametricFilter, SpectrumFrame } from "@/player/engineTypes";
import {
  dbToY,
  formatDb,
  formatFrequency,
  formatFrequencyShort,
  freqToX,
  GRID_DB,
  GRID_FREQS,
  PLOT_MARGIN,
  responseArea,
  responsePath,
  xToFreq,
  yToDb,
} from "./curveGeometry";
import { F_MAX, F_MIN, hasGain, MAX_PARAMETRIC_FILTERS } from "./eqMath";
import { listenToSpectrum } from "./spectrumFeed";
import { useElementSize } from "@/lib/useElementSize";

/** Below this plot width only the decade labels (20, 100, 1k, 10k) fit without overlapping. */
const NARROW_PLOT_PX = 420;
const DECADE_FREQS: ReadonlySet<number> = new Set([20, 100, 1000, 10_000]);
const CLIP_THRESHOLD_DB = -0.1;
const CLIP_HOLD_MS = 1500;
const SPECTRUM_FALL = 5; // band units per frame (0…255 = −90…0 dB)

export interface EqCurveProps {
  eq: EqConfig;
  /** Response of `eq` (from `useEqResponse`, computed as if the EQ were on). */
  response: EqResponse;
  /** Index of the selected parametric filter (highlighted point and table row). */
  selected: number | null;
  onSelect: (index: number | null) => void;
  onFilterChange: (index: number, patch: Partial<ParametricFilter>) => void;
  onFilterAdd: (filter: Partial<ParametricFilter>) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const roundFreq = (f: number) => (f < 100 ? Math.round(f * 10) / 10 : Math.round(f));

/** Draws the analyzer bands as a soft filled area. Colors come from the element's CSS `color`. */
function drawSpectrum(canvas: HTMLCanvasElement, bands: ArrayLike<number>) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const n = bands.length;
  if (n < 2) return;
  const color = getComputedStyle(canvas).color;
  const xAt = (i: number) => ((i + 0.5) / n) * width;
  const yAt = (v: number) => height - (clamp(v, 0, 255) / 255) * height;
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, yAt(bands[0] ?? 0));
  for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(bands[i] ?? 0));
  ctx.lineTo(width, yAt(bands[n - 1] ?? 0));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width / 900);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    if (i === 0) ctx.moveTo(xAt(i), yAt(bands[i] ?? 0));
    else ctx.lineTo(xAt(i), yAt(bands[i] ?? 0));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Response curve (log frequency, ±15 dB) with the live spectrum behind it, a clip indicator and, in
 * parametric mode, draggable filter points (drag = frequency/gain, wheel = Q, double-click = add).
 */
export function EqCurve({ eq, response, selected, onSelect, onFilterChange, onFilterAdd }: EqCurveProps) {
  const { t } = useTranslation();
  const clipId = useId();
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [clipping, setClipping] = useState(false);

  const plotW = Math.max(0, box.width - PLOT_MARGIN.left - PLOT_MARGIN.right);
  const plotH = Math.max(0, box.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom);
  const filters = eq.mode.type === "parametric" ? eq.mode.filters : null;
  const ready = plotW > 0 && plotH > 0;

  // Keep the canvas resolution in step with its size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || plotW === 0 || plotH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(plotW * dpr);
    canvas.height = Math.round(plotH * dpr);
  }, [plotW, plotH]);

  // Analyzer + clip indicator. The engine only computes the spectrum while this page listens.
  useEffect(() => {
    let raf = 0;
    let clipTimer: ReturnType<typeof setTimeout> | undefined;
    let clipOn = false;
    let latest: SpectrumFrame | null = null;
    let smoothed: number[] = [];

    const paint = () => {
      raf = 0;
      const canvas = canvasRef.current;
      if (!canvas || !latest) return;
      const bands = latest.bands;
      // Fast attack, slow fall: the display stays readable at high frame rates.
      smoothed = bands.map((v, i) => Math.max(v, (smoothed[i] ?? 0) - SPECTRUM_FALL));
      drawSpectrum(canvas, smoothed);
    };

    const stop = listenToSpectrum((frame) => {
      latest = frame;
      if (frame.peakDb > CLIP_THRESHOLD_DB) {
        if (!clipOn) {
          clipOn = true;
          setClipping(true);
        }
        clearTimeout(clipTimer);
        clipTimer = setTimeout(() => {
          clipOn = false;
          setClipping(false);
        }, CLIP_HOLD_MS);
      }
      if (!raf) raf = requestAnimationFrame(paint);
    });

    return () => {
      stop();
      cancelAnimationFrame(raf);
      clearTimeout(clipTimer);
    };
  }, []);

  // Mouse wheel over a point changes its Q. Needs a non-passive listener to stop the page from scrolling.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });
  const changeRef = useRef(onFilterChange);
  useEffect(() => {
    changeRef.current = onFilterChange;
  });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const target = (e.target as Element | null)?.closest("[data-filter-index]");
      if (!target) return;
      const index = Number(target.getAttribute("data-filter-index"));
      const filter = filtersRef.current?.[index];
      if (!filter) return;
      e.preventDefault();
      const q = clamp(filter.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 50);
      changeRef.current(index, { q: Math.round(q * 100) / 100 });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [ready]);

  const dragging = useRef<number | null>(null);

  function pointerPosition(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0) - PLOT_MARGIN.left,
      y: e.clientY - (rect?.top ?? 0) - PLOT_MARGIN.top,
    };
  }

  function onPointDown(e: PointerEvent<SVGGElement>, index: number) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = index;
    onSelect(index);
  }

  function onPointMove(e: PointerEvent<SVGGElement>, index: number) {
    if (dragging.current !== index) return;
    const filter = filters?.[index];
    if (!filter) return;
    const { x, y } = pointerPosition(e);
    const patch: Partial<ParametricFilter> = { freqHz: roundFreq(xToFreq(x, plotW)) };
    if (hasGain(filter.kind)) patch.gainDb = Math.round(yToDb(y, plotH) * 10) / 10;
    onFilterChange(index, patch);
  }

  function endDrag() {
    dragging.current = null;
  }

  function onPointKey(e: KeyboardEvent<SVGGElement>, index: number) {
    const filter = filters?.[index];
    if (!filter) return;
    const octaveStep = e.shiftKey ? 2 ** (1 / 3) : 2 ** (1 / 12);
    switch (e.key) {
      case "ArrowLeft":
        onFilterChange(index, { freqHz: roundFreq(clamp(filter.freqHz / octaveStep, F_MIN, F_MAX)) });
        break;
      case "ArrowRight":
        onFilterChange(index, { freqHz: roundFreq(clamp(filter.freqHz * octaveStep, F_MIN, F_MAX)) });
        break;
      case "ArrowUp":
      case "ArrowDown":
        if (!hasGain(filter.kind)) return;
        onFilterChange(index, {
          gainDb: clamp(filter.gainDb + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 2 : 0.5), -24, 24),
        });
        break;
      case "+":
      case "-":
        onFilterChange(index, {
          q: Math.round(clamp(filter.q * (e.key === "+" ? 1.12 : 1 / 1.12), 0.1, 50) * 100) / 100,
        });
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onBackgroundDoubleClick(e: MouseEvent<SVGRectElement>) {
    if (!filters || filters.length >= MAX_PARAMETRIC_FILTERS) return;
    const { x, y } = pointerPosition(e);
    onFilterAdd({
      kind: "peaking",
      freqHz: roundFreq(xToFreq(x, plotW)),
      gainDb: Math.round(yToDb(y, plotH) * 10) / 10,
      q: 1,
    });
  }

  const showTotal = Math.abs(response.effectivePreampDb) >= 0.05;
  // The main curve is the shape the sliders define; the dashed one adds the effective preamp.
  const shape = response.magnitudeDb.map((v) => v - response.effectivePreampDb);
  return (
    <div className="relative">
      <div className="pointer-events-none absolute top-2 right-5 z-10 flex items-center gap-2">
        <span className="sr-only" role="status">
          {clipping ? t("equalizer.curve.clip") : ""}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide uppercase transition-colors",
            clipping ? "bg-danger text-black" : "bg-black/30 text-muted",
          )}
          title={t("equalizer.curve.clipHint")}
        >
          {t("equalizer.curve.clipShort")}
        </span>
      </div>
      <div ref={boxRef} className="relative h-72 w-full select-none sm:h-80">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute text-accent"
          style={{ left: PLOT_MARGIN.left, top: PLOT_MARGIN.top, width: plotW, height: plotH }}
        />
        {ready && (
          <svg
            ref={svgRef}
            width={box.width}
            height={box.height}
            role="img"
            aria-label={t("equalizer.curve.ariaLabel")}
            className={cn("absolute inset-0 overflow-visible", !eq.enabled && "opacity-50")}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={0} width={plotW} height={plotH} />
              </clipPath>
            </defs>
            <g transform={`translate(${PLOT_MARGIN.left} ${PLOT_MARGIN.top})`}>
              <rect
                x={0}
                y={0}
                width={plotW}
                height={plotH}
                className="fill-transparent"
                onDoubleClick={onBackgroundDoubleClick}
              />
              {GRID_DB.map((db) => (
                <g key={db}>
                  <line
                    x1={0}
                    x2={plotW}
                    y1={dbToY(db, plotH)}
                    y2={dbToY(db, plotH)}
                    className={db === 0 ? "stroke-muted" : "stroke-divider"}
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                  <text
                    x={-8}
                    y={dbToY(db, plotH)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted text-[10px] tabular-nums"
                    pointerEvents="none"
                  >
                    {db > 0 ? `+${db}` : db}
                  </text>
                </g>
              ))}
              {GRID_FREQS.map((f) => (
                <g key={f}>
                  <line
                    x1={freqToX(f, plotW)}
                    x2={freqToX(f, plotW)}
                    y1={0}
                    y2={plotH}
                    className="stroke-divider"
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                  {(plotW >= NARROW_PLOT_PX || DECADE_FREQS.has(f)) && (
                    <text
                      x={freqToX(f, plotW)}
                      y={plotH + 16}
                      textAnchor={f === F_MIN ? "start" : f === F_MAX ? "end" : "middle"}
                      className="fill-muted text-[10px]"
                      pointerEvents="none"
                    >
                      {formatFrequencyShort(f)}
                    </text>
                  )}
                </g>
              ))}
              <g clipPath={`url(#${clipId})`} pointerEvents="none">
                <path
                  d={responseArea(response.frequencies, shape, plotW, plotH)}
                  className="fill-accent-soft"
                />
                {showTotal && (
                  <path
                    d={responsePath(response.frequencies, response.magnitudeDb, plotW, plotH)}
                    className="stroke-subdued"
                    fill="none"
                    strokeWidth={1.25}
                    strokeDasharray="4 4"
                  />
                )}
                <path
                  d={responsePath(response.frequencies, shape, plotW, plotH)}
                  className="stroke-accent"
                  fill="none"
                  strokeWidth={2.25}
                  strokeLinejoin="round"
                />
              </g>
              {filters?.map((filter, index) => {
                const x = freqToX(filter.freqHz, plotW);
                const y = dbToY(hasGain(filter.kind) ? filter.gainDb : 0, plotH);
                const isSelected = selected === index;
                return (
                  <g
                    key={index}
                    data-filter-index={index}
                    tabIndex={0}
                    role="slider"
                    aria-label={t("equalizer.curve.point", { n: index + 1 })}
                    aria-valuemin={F_MIN}
                    aria-valuemax={F_MAX}
                    aria-valuenow={Math.round(filter.freqHz)}
                    aria-valuetext={`${t(`equalizer.filterTypes.${filter.kind}`)}, ${formatFrequency(filter.freqHz)}, ${
                      hasGain(filter.kind) ? `${formatDb(filter.gainDb)}, ` : ""
                    }Q ${filter.q}`}
                    transform={`translate(${clamp(x, 0, plotW)} ${clamp(y, 0, plotH)})`}
                    className="cursor-grab outline-none active:cursor-grabbing"
                    onPointerDown={(e) => onPointDown(e, index)}
                    onPointerMove={(e) => onPointMove(e, index)}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onFocus={() => onSelect(index)}
                    onKeyDown={(e) => onPointKey(e, index)}
                  >
                    <circle r={14} className="fill-transparent" />
                    {isSelected && <circle r={12} className="fill-none stroke-text" strokeWidth={1.5} />}
                    <circle
                      r={9}
                      className={filter.enabled ? "fill-accent stroke-surface" : "fill-muted stroke-surface"}
                      strokeWidth={2}
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="fill-on-accent text-[10px] font-bold"
                      pointerEvents="none"
                    >
                      {index + 1}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
      {filters && <p className="px-2 pt-1 text-[13px] text-subdued">{t("equalizer.curve.parametricHint")}</p>}
    </div>
  );
}

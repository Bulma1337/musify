import { patternShapes } from "./patterns";
import type { PatternKind, RecapPalette } from "./palette";

/**
 * Draws the Recap share images (PNG, 9:16 story and 1:1 square) on a 2D canvas. No dependencies:
 * the background pattern is the same list of SVG paths the on-screen Recap uses, drawn via Path2D.
 */

export type ShareFormat = "story" | "square";

export const SHARE_SIZE: Record<ShareFormat, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

/** Texts already translated, so this module needs no i18n. */
export interface ShareContent {
  year: number;
  title: string;
  /** "Minuten Musik" */
  minutesLabel: string;
  minutes: string;
  topSongLabel: string;
  topSong?: { title: string; artist: string };
  topArtistsLabel: string;
  topArtists: string[];
  topSongsLabel: string;
  topSongs: string[];
  topGenre?: string;
  topGenreLabel: string;
  personality: string;
  personalityLabel: string;
  footer: string;
}

/** The slice of the canvas API used here, so tests can pass a recording stub. */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fill(path?: Path2D): void;
  stroke(path?: Path2D): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  beginPath(): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  clip(): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

export const FONT_FAMILY = '"Figtree Variable", "Segoe UI", system-ui, sans-serif';
const font = (weight: number, size: number) => `${weight} ${size}px ${FONT_FAMILY}`;

/** Breaks `text` into at most `maxLines` lines no wider than `maxWidth`; overflow ends in an ellipsis. */
export function wrapText(
  ctx: Pick<Ctx2D, "measureText">,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    // The last allowed line takes all remaining words (and gets cut with an ellipsis below).
    if (lines.length === maxLines - 1) break;
    lines.push(line);
    line = word;
  }
  if (i < words.length) line = [line, ...words.slice(i)].join(" ");
  if (line) lines.push(line);
  return lines.map((l) => ellipsize(ctx, l, maxWidth));
}

/** Shortens `text` with "…" until it fits. */
export function ellipsize(ctx: Pick<Ctx2D, "measureText">, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end).trimEnd()}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

export interface DrawOptions {
  format: ShareFormat;
  palette: RecapPalette;
  pattern: PatternKind;
  content: ShareContent;
  /** Cover of the top song, if it could be loaded. */
  cover?: CanvasImageSource | null;
  /** Builds a path from SVG path data; defaults to `Path2D`. */
  makePath?: (d: string) => Path2D;
}

export function drawRecap(ctx: Ctx2D, { format, palette, pattern, content, cover, makePath }: DrawOptions) {
  const { width, height } = SHARE_SIZE[format];
  const path = makePath ?? ((d: string) => new Path2D(d));
  const story = format === "story";

  // Background gradient.
  const gradient = ctx.createLinearGradient(0, 0, width * 0.45, height);
  gradient.addColorStop(0, palette.bgFrom);
  gradient.addColorStop(1, palette.bgTo);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Pattern, scaled from its 100-unit-wide space.
  ctx.save();
  ctx.scale(width / 100, width / 100);
  for (const shape of patternShapes(pattern, content.year, height / width)) {
    const color = shape.tone === "ink" ? palette.ink : palette.accent;
    ctx.globalAlpha = shape.opacity;
    if (shape.mode === "fill") {
      ctx.fillStyle = color;
      ctx.fill(path(shape.d));
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = shape.width ?? 0.6;
      ctx.lineCap = "round";
      ctx.stroke(path(shape.d));
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  const margin = 84;
  const inner = width - margin * 2;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    weight: number,
    color: string,
    maxWidth?: number,
  ) => {
    ctx.font = font(weight, size);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y, maxWidth);
  };

  // Header.
  text(content.footer.toUpperCase(), margin, story ? 150 : 120, 32, 700, palette.inkSoft);
  text(content.title, margin, story ? 280 : 215, story ? 128 : 104, 800, palette.ink, inner);

  // Minutes.
  const minutesY = story ? 560 : 430;
  text(content.minutes, margin, minutesY, story ? 230 : 170, 800, palette.accent, inner);
  text(content.minutesLabel, margin, minutesY + (story ? 70 : 56), story ? 50 : 42, 600, palette.ink, inner);

  // Top song with its cover.
  const songY = story ? 800 : 560;
  const coverSize = story ? 400 : 320;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(margin, songY, coverSize, coverSize, 28);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, margin, songY, coverSize, coverSize);
  } else {
    ctx.fillStyle = palette.panel;
    ctx.fillRect(margin, songY, coverSize, coverSize);
  }
  ctx.restore();

  const textX = margin + coverSize + 48;
  const textWidth = width - textX - margin;
  text(content.topSongLabel, textX, songY + 52, 30, 700, palette.inkSoft, textWidth);
  if (content.topSong) {
    ctx.font = font(800, story ? 62 : 56);
    const titleLines = wrapText(ctx, content.topSong.title, textWidth, 4);
    titleLines.forEach((line, i) =>
      text(line, textX, songY + 130 + i * (story ? 74 : 66), story ? 62 : 56, 800, palette.ink),
    );
    text(
      ellipsize(ctx, content.topSong.artist, textWidth),
      textX,
      songY + 130 + titleLines.length * (story ? 74 : 66) + 14,
      38,
      500,
      palette.inkSoft,
    );
  }

  // Lists: stacked in the story, side by side in the square.
  const listTop = story ? songY + coverSize + 110 : songY + coverSize + 80;
  const columnWidth = story ? inner : (inner - 48) / 2;
  const list = (label: string, items: string[], x: number, y: number) => {
    text(label, x, y, 32, 700, palette.inkSoft, columnWidth);
    items.slice(0, 3).forEach((item, i) => {
      const rowY = y + 62 + i * 62;
      text(String(i + 1), x, rowY, 40, 800, palette.accent);
      ctx.font = font(600, 40);
      text(ellipsize(ctx, item, columnWidth - 64), x + 56, rowY, 40, 600, palette.ink);
    });
  };
  if (story) {
    list(content.topArtistsLabel, content.topArtists, margin, listTop);
    list(content.topSongsLabel, content.topSongs, margin, listTop + 290);
  } else {
    list(content.topArtistsLabel, content.topArtists, margin, listTop);
    list(content.topSongsLabel, content.topSongs, margin + columnWidth + 48, listTop);
  }

  // Personality chip at the bottom.
  const chipY = height - (story ? 250 : 120);
  ctx.font = font(800, 44);
  const chipText = content.personality;
  const chipWidth = Math.min(inner, ctx.measureText(chipText).width + 80);
  ctx.fillStyle = palette.panel;
  ctx.beginPath();
  ctx.roundRect(margin, chipY - 62, chipWidth, 92, 46);
  ctx.fill();
  text(ellipsize(ctx, chipText, chipWidth - 80), margin + 40, chipY, 44, 800, palette.ink);
  if (story) {
    text(content.personalityLabel, margin, chipY - 96, 30, 700, palette.inkSoft, inner);
    if (content.topGenre) {
      text(
        `${content.topGenreLabel}: ${content.topGenre}`,
        margin,
        chipY + 100,
        36,
        600,
        palette.inkSoft,
        inner,
      );
    }
  }
}

/** Renders to a canvas element and encodes a PNG. Waits for the app font to be ready first. */
export async function renderRecapPng(options: Omit<DrawOptions, "makePath">): Promise<Blob> {
  const { width, height } = SHARE_SIZE[options.format];
  if ("fonts" in document) {
    await Promise.all([
      document.fonts.load(font(800, 64)),
      document.fonts.load(font(600, 40)),
      document.fonts.load(font(500, 38)),
    ]).catch(() => {});
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  drawRecap(ctx as unknown as Ctx2D, options);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
      "image/png",
    ),
  );
}

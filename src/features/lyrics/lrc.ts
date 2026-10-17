import type { LyricLine, LyricWord, Lyrics } from "@/api/provider";

/** Tags from the header of an LRC file. */
export interface LrcMeta {
  artist?: string;
  title?: string;
  album?: string;
  /** Track length from `[length:mm:ss]`. */
  lengthMs?: number;
  /** `[offset:±ms]` exactly as written: positive values make lines appear earlier. */
  offsetMs?: number;
  language?: string;
}

export interface LrcDocument {
  /** Null when the text contains no lyric lines at all. */
  lyrics: Lyrics | null;
  meta: LrcMeta;
}

/** `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss]` or `[mm:ss:xx]` at the start of a line. */
const LINE_STAMP = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
/** `<mm:ss.xx>` inside a line (enhanced LRC word timing). */
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
/** `[key:value]` header tag such as `[ar:Artist]`. */
const META_TAG = /^\s*\[([A-Za-z#]+):\s*(.*?)\s*\]\s*$/;

function stampToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  // "5" = deciseconds, "50" = centiseconds, "500" = milliseconds.
  const fractionMs = fraction ? parseInt(fraction.padEnd(3, "0").slice(0, 3), 10) : 0;
  return (parseInt(minutes, 10) * 60 + parseInt(seconds, 10)) * 1000 + fractionMs;
}

function parseLength(value: string): number | undefined {
  const match = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value);
  return match ? stampToMs(match[1]!, match[2]!, match[3]) : undefined;
}

function applyMeta(meta: LrcMeta, key: string, value: string): void {
  switch (key.toLowerCase()) {
    case "ar":
      meta.artist = value;
      break;
    case "ti":
      meta.title = value;
      break;
    case "al":
      meta.album = value;
      break;
    case "length":
      meta.lengthMs = parseLength(value);
      break;
    case "offset": {
      const parsed = parseInt(value.replace(/^\+/, ""), 10);
      if (Number.isFinite(parsed)) meta.offsetMs = parsed;
      break;
    }
    case "la":
    case "lang":
      if (value) meta.language = value.toLowerCase();
      break;
  }
}

/**
 * Splits `text` at `<mm:ss.xx>` markers. Returns null when the line has no word timing.
 * Text in front of the first marker is sung from `lineStartMs` on; a marker without text only closes
 * the previous word.
 */
function parseWords(text: string, lineStartMs: number): { words: LyricWord[]; plain: string } | null {
  const markers = [...text.matchAll(WORD_STAMP)];
  if (markers.length === 0) return null;

  const words: LyricWord[] = [];
  const lead = text.slice(0, markers[0]!.index);
  if (lead.trim() !== "") words.push({ startMs: lineStartMs, text: lead });

  markers.forEach((marker, i) => {
    const start = stampToMs(marker[1]!, marker[2]!, marker[3]);
    const segment = text.slice(marker.index + marker[0].length, markers[i + 1]?.index ?? text.length);
    const previous = words[words.length - 1];
    if (previous && previous.endMs === undefined) previous.endMs = start;
    if (segment.trim() === "") {
      if (previous) previous.text += segment;
      return;
    }
    words.push({ startMs: start, text: segment });
  });

  const last = words[words.length - 1];
  if (last) last.text = last.text.replace(/s+$/, "");
  const plain = words
    .map((w) => w.text)
    .join("")
    .replace(/s+/g, " ")
    .trim();
  return { words, plain };
}

/**
 * Parses LRC text (also the "enhanced" variant with `<mm:ss.xx>` word timing) into the `Lyrics` model.
 *
 * - Several stamps in front of a line repeat it at each time (choruses).
 * - Lines are sorted by time. A stamp without text is a timed spacer (`text: ""`).
 * - `[offset:+500]` makes lines appear 500 ms earlier; it is stored as `offsetMs: -500` because the
 *   model's displayed time is `startMs + offsetMs`.
 * - Text without any stamps becomes unsynced lines (blank lines stay as spacers).
 */
export function parseLrcDocument(input: string, source: Lyrics["source"] = "lrclib"): LrcDocument {
  const meta: LrcMeta = {};
  const raw = input.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);

  const timed: LyricLine[] = [];
  const unstamped: string[] = [];
  let sawStamp = false;

  for (const rawLine of raw) {
    const stamps: number[] = [];
    let rest = rawLine;
    for (;;) {
      const match = LINE_STAMP.exec(rest);
      if (!match) break;
      stamps.push(stampToMs(match[1]!, match[2]!, match[3]));
      rest = rest.slice(match[0].length);
    }

    if (stamps.length === 0) {
      const tag = META_TAG.exec(rawLine);
      if (tag) {
        applyMeta(meta, tag[1]!, tag[2]!);
        continue;
      }
      unstamped.push(rawLine.trimEnd());
      continue;
    }

    sawStamp = true;
    const firstStamp = stamps[0]!;
    const parsed = parseWords(rest, firstStamp);
    const text = parsed ? parsed.plain : rest.trim();
    for (const stamp of stamps) {
      const line: LyricLine = { startMs: stamp, text };
      if (parsed && parsed.words.length > 0) {
        const shift = stamp - firstStamp;
        line.words = parsed.words.map((w) => {
          const word: LyricWord = { startMs: w.startMs + shift, text: w.text };
          if (w.endMs !== undefined) word.endMs = w.endMs + shift;
          return word;
        });
      }
      timed.push(line);
    }
  }

  const offsetMs = meta.offsetMs ? -meta.offsetMs : 0;

  if (sawStamp) {
    timed.sort((a, b) => a.startMs! - b.startMs!);
    if (timed.every((l) => l.text === "")) return { lyrics: null, meta };
    const lyrics: Lyrics = { synced: true, lines: timed, offsetMs, source };
    if (meta.language) lyrics.language = meta.language;
    return { lyrics, meta };
  }

  const lines = unstamped.map((text) => (text.trim() === "" ? "" : text));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { lyrics: null, meta };
  const lyrics: Lyrics = { synced: false, lines: lines.map((text) => ({ text })), offsetMs: 0, source };
  if (meta.language) lyrics.language = meta.language;
  return { lyrics, meta };
}

/** Convenience wrapper around `parseLrcDocument` that returns only the lyrics. */
export function parseLrc(input: string, source: Lyrics["source"] = "lrclib"): Lyrics | null {
  return parseLrcDocument(input, source).lyrics;
}

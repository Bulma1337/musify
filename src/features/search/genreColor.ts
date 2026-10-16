/** Deterministic hue from the genre name, so a genre keeps its color across sessions. */
export function genreColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 52% 34%)`;
}

/** Deterministic header color for a genre name (stable hue from a string hash). */
export function genreColor(name: string): { base: string; dark: string } {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = hash % 360;
  return { base: `hsl(${hue} 55% 38%)`, dark: `hsl(${hue} 55% 22%)` };
}

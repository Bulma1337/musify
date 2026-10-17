import i18n from "@/i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `1.5 GB`, `320 KB` … with the number formatted for the UI language. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
  return `${number} ${UNITS[unit]}`;
}

/** Percent (0–100, rounded) of a 0…1 fraction. */
export const percent = (fraction: number) => Math.max(0, Math.min(100, Math.round(fraction * 100)));

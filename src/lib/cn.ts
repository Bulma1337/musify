import { clsx, type ClassValue } from "clsx";

/** Joins class names conditionally. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

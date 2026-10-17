import type { TFunction } from "i18next";
import { describeError } from "@/api/errors";

/** Text for an error from the server adapters or from a native command (which rejects with a string). */
export function errorMessage(t: TFunction, error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error instanceof Error && !("kind" in error) && error.message) return error.message;
  return describeError(t, error);
}

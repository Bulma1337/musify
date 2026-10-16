import type { TFunction } from "i18next";
import { ProviderError } from "./provider";

/** User-facing, translated message for any error coming from a server adapter. */
export function describeError(t: TFunction, error: unknown): string {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case "auth":
        return t("errors.auth");
      case "network":
        return t("errors.network");
      case "timeout":
        return t("errors.timeout");
      case "notFound":
        return t("errors.notFound");
      case "unsupported":
        return t("errors.unsupported");
      case "invalidResponse":
        return t("errors.invalidResponse");
      case "server":
        return t("errors.server", { code: error.code ?? "?" });
    }
  }
  return t("errors.unknown");
}

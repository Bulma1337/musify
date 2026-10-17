import { isRouteErrorResponse, useRouteError } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

/**
 * Friendly fallback when a page crashes: explains and offers a reload instead of a stack trace. An
 * unknown address gets "page not found" and a way back home instead.
 */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error ?? "");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-backdrop p-8 text-center">
      <img src="/musify.svg" alt="" className="size-12" draggable={false} />
      <h1 className="text-2xl font-bold">{notFound ? t("app.notFoundTitle") : t("app.crashTitle")}</h1>
      <p className="max-w-md text-subdued">{notFound ? t("app.notFoundText") : t("app.crashText")}</p>
      {import.meta.env.DEV && message && !notFound && (
        <pre className="max-w-2xl overflow-auto rounded-md bg-elevated p-3 text-left text-xs text-subdued">
          {message}
        </pre>
      )}
      {notFound ? (
        <Button
          onClick={() => {
            location.hash = "#/";
          }}
        >
          {t("app.toHome")}
        </Button>
      ) : (
        <Button onClick={() => location.reload()}>{t("app.reload")}</Button>
      )}
    </div>
  );
}

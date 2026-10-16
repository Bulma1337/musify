import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useGridColumns } from "./useGridColumns";

export interface ShelfProps<T> {
  title: string;
  /** "Alle anzeigen" target. */
  moreTo?: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
  getKey: (item: T) => string;
}

/** A titled single row of cards that shows as many items as fit (like home page sections). */
export function Shelf<T>({ title, moreTo, items, renderItem, getKey }: ShelfProps<T>) {
  const { t } = useTranslation();
  const { ref, columns } = useGridColumns();
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-end justify-between gap-4 px-3">
        {moreTo ? (
          <Link to={moreTo} className="truncate text-2xl font-bold tracking-tight hover:underline">
            {title}
          </Link>
        ) : (
          <h2 className="truncate text-2xl font-bold tracking-tight">{title}</h2>
        )}
        {moreTo && items.length > columns && (
          <Link to={moreTo} className="shrink-0 text-sm font-bold text-subdued hover:underline">
            {t("common.showAll")}
          </Link>
        )}
      </div>
      <div ref={ref} className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {items.slice(0, columns).map((item) => (
          <div key={getKey(item)} className="min-w-0">
            {renderItem(item)}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Full grid version used by "Alle anzeigen" pages. */
export function CardGrid<T>({ items, renderItem, getKey }: Omit<ShelfProps<T>, "title" | "moreTo">) {
  const { ref, columns } = useGridColumns();
  return (
    <div ref={ref} className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.map((item) => (
        <div key={getKey(item)} className="min-w-0">
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { CircleArrowDown } from "lucide-react";
import { DownloadedGlyph } from "@/features/downloads/DownloadButton";
import { useCollectionStatus } from "@/features/downloads/store";
import type { CollectionKind } from "@/features/downloads/types";
import type { LibraryEntry } from "./libraryModel";

const KINDS: Partial<Record<LibraryEntry["kind"], CollectionKind>> = {
  playlist: "playlist",
  album: "album",
  liked: "favorites",
};

function Mark({ kind, itemId }: { kind: CollectionKind; itemId?: string }) {
  const { t } = useTranslation();
  const status = useCollectionStatus(kind, itemId);
  if (!status.registered || status.total === 0) return null;
  if (status.done === status.total) {
    return (
      <span title={t("downloads.indicator.done")} className="grid shrink-0 place-items-center">
        <DownloadedGlyph size={14} />
      </span>
    );
  }
  if (status.active > 0) {
    return (
      <span title={t("downloads.indicator.pending")} className="grid shrink-0 place-items-center text-muted">
        <CircleArrowDown size={14} />
      </span>
    );
  }
  return null;
}

/** Download state of a library entry: filled when everything is on this computer, grey while it loads. */
export function LibraryDownloadMark({ entry }: { entry: LibraryEntry }) {
  const kind = KINDS[entry.kind];
  if (!kind) return null;
  return <Mark kind={kind} itemId={kind === "favorites" ? undefined : entry.id} />;
}

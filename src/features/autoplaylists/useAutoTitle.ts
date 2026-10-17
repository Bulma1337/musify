import { useTranslation } from "react-i18next";
import type { AutoRef } from "./autoPlaylists";

/** Display name of an automatic playlist ("Deine Dauerbrenner", "Top-Songs 2026" …). */
export function useAutoTitle(auto: AutoRef): string {
  const { t } = useTranslation();
  return t(`autoPlaylists.title.${auto.kind}`, { year: auto.year });
}

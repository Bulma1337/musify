import { useQuery } from "@tanstack/react-query";
import { useProvider } from "@/api/session";
import { prepareHistory } from "./demoHistory";
import { getHistory } from "./history";
import { rangeBounds, rangeKey, type StatsRange } from "./ranges";

/** Statistics change only when something was played; a short stale time keeps navigation snappy. */
const STALE_MS = 30_000;

/** Summary of the history for a range (top lists limited to `topLimit` entries). */
export function useStatsSummary(range: StatsRange, topLimit = 10) {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "stats", rangeKey(range), topLimit],
    queryFn: async () => {
      await prepareHistory(provider);
      const { from, to } = rangeBounds(range);
      return getHistory().summary(provider.server.id, from, to, topLimit);
    },
    staleTime: STALE_MS,
  });
}

/** Calendar years with listening history, ascending. */
export function useHistoryYears() {
  const provider = useProvider();
  return useQuery({
    queryKey: [provider.server.id, "stats", "years"],
    queryFn: async () => {
      await prepareHistory(provider);
      return getHistory().years(provider.server.id);
    },
    staleTime: STALE_MS,
  });
}

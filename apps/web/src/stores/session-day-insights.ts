import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { TimelineResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { buildSessionDayInsights, type SessionDayRange } from "../utils/session-day-insights";
import { queryKeys } from "./query-keys";

/**
 * Whole-day Session counts and per-Session created Knowledge for the days on the Work history page,
 * from one timeline request. The page decides when the numbers match its list and sets `scope` only then.
 */
export const useSessionDayInsightsStore = defineStore("session-day-insights", () => {
  const scope = ref<(SessionDayRange & { projectId: string }) | null>(null);

  const query = useQuery<TimelineResult>({
    key: () => [...queryKeys.views.sessionDays, scope.value],
    enabled: computed(() => scope.value !== null),
    query: ({ signal }) => {
      const current = scope.value;
      if (!current) throw new Error("A day range must be set before loading day insights.");
      return useApi().client.getTimeline(
        { projectId: current.projectId || undefined, from: current.from, to: current.to },
        signal,
      );
    },
  });

  const insights = computed(() => (scope.value ? buildSessionDayInsights(query.data.value) : null));

  return { scope, insights };
});

import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { HotspotGroup, HotspotQuery, HotspotResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage, toDateInputValue } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

export type HotspotPeriod = "30" | "90" | "365" | "all";

function periodStart(period: HotspotPeriod, today = new Date()): string | undefined {
  if (period === "all") return undefined;
  const start = new Date(today);
  start.setDate(start.getDate() - Number(period) + 1);
  return toDateInputValue(start);
}

/** Owns the graph page's hotspot view: the most changed files or directories of tracked projects. */
export const useHotspotsStore = defineStore("hotspots", () => {
  const enabled = ref(false);
  const projectId = ref("");
  const groupBy = ref<HotspotGroup>("file");
  const period = ref<HotspotPeriod>("90");

  function scope(): HotspotQuery {
    return {
      projectId: projectId.value || undefined,
      groupBy: groupBy.value,
      from: periodStart(period.value),
      limit: 50,
    };
  }

  const query = useQuery<HotspotResult>({
    key: () => [...queryKeys.views.hotspots, scope()],
    enabled,
    query: ({ signal }) => useApi().client.getHotspots(scope(), signal),
  });

  const hotspots = computed(() => (query.data.value?.outcome === "hotspots" ? query.data.value.items : []));
  const hotspotsLoading = computed(() => query.isLoading.value);
  const hotspotsError = computed(() => {
    if (query.error.value) return errorMessage(query.error.value, t("graph.couldNotLoadHotspotFiles"));
    const result = query.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? t("common.trackingIsNotEnabledFor")) : "";
  });

  function setActive(active: boolean): void {
    enabled.value = active;
  }

  return { projectId, groupBy, period, hotspots, hotspotsLoading, hotspotsError, setActive };
});

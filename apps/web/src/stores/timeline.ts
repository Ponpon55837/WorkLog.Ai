import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { TimelineQuery, TimelineResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage, toDateInputValue } from "../utils/format";
import { queryKeys } from "./query-keys";

export type TimelineRange = "7" | "30" | "90" | "365";

function rangeStart(days: TimelineRange, today = new Date()): string {
  const start = new Date(today);
  start.setDate(start.getDate() - Number(days) + 1);
  return toDateInputValue(start);
}

/** Owns the graph page's timeline view: the date range and the Sessions, Knowledge events, and links in it. */
export const useTimelineStore = defineStore("timeline", () => {
  const enabled = ref(false);
  const projectId = ref("");
  const range = ref<TimelineRange>("30");

  function scope(): TimelineQuery {
    return {
      projectId: projectId.value || undefined,
      from: rangeStart(range.value),
      to: toDateInputValue(new Date()),
    };
  }

  const query = useQuery<TimelineResult>({
    key: () => [...queryKeys.views.timeline, scope()],
    enabled,
    query: ({ signal }) => useApi().client.getTimeline(scope(), signal),
  });

  const timeline = computed(() => (query.data.value?.outcome === "timeline" ? query.data.value : null));
  const timelineLoading = computed(() => query.isLoading.value);
  const timelineError = computed(() => {
    if (query.error.value) return errorMessage(query.error.value, "無法載入時間軸。");
    const result = query.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? "此專案目前未啟用記錄。") : "";
  });

  function setActive(active: boolean): void {
    enabled.value = active;
  }

  return { projectId, range, timeline, timelineLoading, timelineError, setActive };
});

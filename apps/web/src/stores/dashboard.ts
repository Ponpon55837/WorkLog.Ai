import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AttentionResult, KnowledgePageListResult, TimelineResult, WorkReport } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { countKnowledgeEvents, countRevisedPages } from "../utils/dashboard-cycle";
import { queryKeys } from "./query-keys";

/** Owns full dashboard report totals and the unfiltered app-shell attention count. */
export const useDashboardStore = defineStore("dashboard", () => {
  const overviewEnabled = ref(false);
  /** True while the overview's weekly loop is on screen; the Knowledge reads only run then. */
  const cycleEnabled = ref(false);
  const overviewQuery = useQuery({
    key: queryKeys.dashboard.overview,
    enabled: overviewEnabled,
    query: async ({ signal }): Promise<WorkReport | null> => {
      const result = await useApi().client.getReport({ period: "week", evidencePageSize: 1 }, signal);
      return result.outcome === "report" ? result : null;
    },
  });
  const attentionQuery = useQuery<AttentionResult>({
    key: [...queryKeys.attention.list, { projectId: "", kind: "", page: 1, pageSize: 20 }],
    enabled: overviewEnabled,
    query: ({ signal }) => useApi().client.getAttention({ page: 1, pageSize: 20 }, signal),
  });
  const weekRange = computed(() => {
    const range = overviewQuery.data.value?.range;
    return range ? { from: range.from, to: range.to } : null;
  });
  // The weekly cycle reads the same Monday-to-Sunday range as the report, so both count one week.
  const timelineQuery = useQuery<TimelineResult>({
    key: () => [...queryKeys.dashboard.cycleTimeline, weekRange.value],
    enabled: () => cycleEnabled.value && weekRange.value !== null,
    query: ({ signal }) => useApi().client.getTimeline(weekRange.value!, signal),
  });
  // Shares the Knowledge page list's cache entry, so a Knowledge page change refreshes the count too.
  const pagesQuery = useQuery<KnowledgePageListResult>({
    key: () => [...queryKeys.knowledge.pages, ""],
    enabled: cycleEnabled,
    query: ({ signal }) => useApi().client.listKnowledgePages(undefined, signal),
  });
  const weekReport = computed(() => overviewQuery.data.value ?? null);
  const weekReportLoaded = computed(() => overviewQuery.data.value !== undefined);
  const weekReportFailed = computed(() => Boolean(overviewQuery.error.value));
  const inbox = computed(() =>
    attentionQuery.data.value?.outcome === "attention" ? attentionQuery.data.value.items : [],
  );
  const attentionCount = computed(() =>
    attentionQuery.data.value?.outcome === "attention" ? attentionQuery.data.value.minimumTotal : undefined,
  );
  const attentionFailed = computed(() => Boolean(attentionQuery.error.value));
  const attentionComplete = computed(
    () =>
      !attentionFailed.value &&
      attentionQuery.data.value?.outcome === "attention" &&
      attentionQuery.data.value.groups.every((group) => group.state === "complete"),
  );
  const attentionLoaded = computed(() => attentionQuery.data.value !== undefined);
  const dashboardLoading = computed(() => overviewQuery.isLoading.value || attentionQuery.isLoading.value);
  const weekVerification = computed(() => {
    const totals = weekReport.value?.totals;
    return {
      total: totals?.sessions ?? 0,
      passed: totals?.verification.passed ?? 0,
      failed: totals?.verification.failed ?? 0,
      inProgress: totals?.verification.in_progress ?? 0,
      notRun: totals?.verification.not_run ?? 0,
      notSupplied: totals?.verification.not_supplied ?? 0,
    };
  });
  /** Knowledge events this week; null while loading, and when the timeline could not be read. */
  const cycleEvents = computed(() => {
    const data = timelineQuery.data.value;
    return data?.outcome === "timeline" ? countKnowledgeEvents(data.knowledgeEvents) : null;
  });
  const cycleEventsFailed = computed(
    () => Boolean(timelineQuery.error.value) || timelineQuery.data.value?.outcome === "skipped",
  );
  /** Knowledge pages written this week; null while loading, and when the page list could not be read. */
  const cycleRevisedPages = computed(() => {
    const data = pagesQuery.data.value;
    const range = weekRange.value;
    return data?.outcome === "knowledge_pages" && range ? countRevisedPages(data.items, range.from, range.to) : null;
  });
  const cyclePagesFailed = computed(
    () => Boolean(pagesQuery.error.value) || pagesQuery.data.value?.outcome === "skipped",
  );
  function setCycleActive(active: boolean): void {
    cycleEnabled.value = active;
  }
  async function reloadCycle(): Promise<void> {
    await Promise.allSettled([timelineQuery.refetch(true), pagesQuery.refetch(true)]);
  }
  async function loadDashboardData(): Promise<void> {
    overviewEnabled.value = true;
    await Promise.allSettled([overviewQuery.refetch(true), attentionQuery.refetch(true)]);
  }
  return {
    weekReport,
    weekReportLoaded,
    weekReportFailed,
    weekVerification,
    inbox,
    attentionCount,
    attentionComplete,
    attentionFailed,
    attentionLoaded,
    dashboardLoading,
    cycleEvents,
    cycleEventsFailed,
    cycleRevisedPages,
    cyclePagesFailed,
    setCycleActive,
    reloadCycle,
    loadDashboardData,
  };
});

import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AttentionResult, WorkReport } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

/** Owns full dashboard report totals and the unfiltered app-shell attention count. */
export const useDashboardStore = defineStore("dashboard", () => {
  const overviewEnabled = ref(false);
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
    loadDashboardData,
  };
});

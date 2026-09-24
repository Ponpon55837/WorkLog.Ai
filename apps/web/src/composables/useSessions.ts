import { computed, ref } from "vue";
import type { PageInfo, WorkSessionRecord } from "@work-intelligence/core";
import type { ListPageSize } from "../utils/labels";
import { runKeyed, useApi } from "./useApi";

export const emptyPageInfo: PageInfo = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
  truncated: false,
};

const sessions = ref<WorkSessionRecord[]>([]);
const sessionsLoading = ref(false);
const sessionsLoaded = ref(false);
const searchTerm = ref("");
const selectedProjectId = ref("");
const sessionPage = ref(1);
const sessionPageSize = ref<ListPageSize>(10);
const sessionPageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const dateFrom = ref("");
const dateTo = ref("");
const sessionFilterError = ref("");
const hasSessionFilters = computed(() =>
  Boolean(searchTerm.value || selectedProjectId.value || dateFrom.value || dateTo.value),
);

async function loadSessions(): Promise<void> {
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
    sessionFilterError.value = "起始日期必須早於或等於結束日期。";
    return;
  }
  sessionFilterError.value = "";
  sessionsLoading.value = true;
  await runKeyed(
    "worklog-sessions",
    async (signal) => {
      const result = await useApi().client.listSessions(
        {
          q: searchTerm.value.trim() || undefined,
          projectId: selectedProjectId.value || undefined,
          from: dateFrom.value || undefined,
          to: dateTo.value || undefined,
          page: sessionPage.value,
          pageSize: sessionPageSize.value,
        },
        signal,
      );
      sessions.value = result.items;
      sessionPageInfo.value = result.pageInfo;
      if (sessionPage.value !== result.pageInfo.page) {
        sessionPage.value = result.pageInfo.page;
      }
      sessionsLoaded.value = true;
    },
    {
      onSettled: () => {
        sessionsLoading.value = false;
      },
    },
  );
}

function clearSessionFilters(): void {
  searchTerm.value = "";
  selectedProjectId.value = "";
  dateFrom.value = "";
  dateTo.value = "";
}

export function useSessions() {
  return {
    sessions,
    sessionsLoading,
    sessionsLoaded,
    searchTerm,
    selectedProjectId,
    sessionPage,
    sessionPageSize,
    sessionPageInfo,
    dateFrom,
    dateTo,
    sessionFilterError,
    hasSessionFilters,
    loadSessions,
    clearSessionFilters,
  };
}

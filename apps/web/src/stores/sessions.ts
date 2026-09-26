import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { PageInfo, SessionDetail, SessionVoidedFilter } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import type { ListPageSize } from "../utils/labels";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { queryKeys } from "./query-keys";

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

/** Owns the filtered Session list query and its URL-backed view state. */
export const useSessionsStore = defineStore("sessions", () => {
  const selectedSessionId = ref<string | null>(null);
  const sequence = ref<string[]>([]);
  const listActive = ref(false);
  const searchTerm = ref("");
  const selectedProjectId = ref("");
  const sessionPage = ref(1);
  const sessionPageSize = ref<ListPageSize>(10);
  const dateFrom = ref("");
  const dateTo = ref("");
  const voidedFilter = ref<SessionVoidedFilter>("exclude");
  const sessionFilterError = ref("");
  const hasSessionFilters = computed(() =>
    Boolean(
      searchTerm.value || selectedProjectId.value || dateFrom.value || dateTo.value || voidedFilter.value !== "exclude",
    ),
  );
  const dateRangeIsValid = computed(() => !(dateFrom.value && dateTo.value && dateFrom.value > dateTo.value));

  const sessionsQuery = useQuery({
    key: queryKeys.sessions.list,
    enabled: computed(() => listActive.value && dateRangeIsValid.value),
    query: ({ signal }) =>
      useApi().client.listSessions(
        {
          q: searchTerm.value.trim() || undefined,
          projectId: selectedProjectId.value || undefined,
          voided: voidedFilter.value,
          from: dateFrom.value || undefined,
          to: dateTo.value || undefined,
          page: sessionPage.value,
          pageSize: sessionPageSize.value,
        },
        signal,
      ),
  });
  const detailQuery = useQuery({
    key: () => [...queryKeys.sessions.detail, selectedSessionId.value],
    enabled: computed(() => selectedSessionId.value !== null),
    query: ({ signal }): Promise<SessionDetail> => {
      const sessionId = selectedSessionId.value;
      if (!sessionId) throw new Error("A Session must be selected before loading its detail.");
      return useApi().client.getSessionDetail(sessionId, signal);
    },
  });

  const sessions = computed(() => sessionsQuery.data.value?.items ?? []);
  const sessionsLoading = computed(() => sessionsQuery.isLoading.value);
  const sessionsLoaded = computed(() => sessionsQuery.data.value !== undefined);
  const sessionPageInfo = computed(() => sessionsQuery.data.value?.pageInfo ?? { ...emptyPageInfo, pageSize: 10 });
  const selectedDetail = computed(() => detailQuery.data.value ?? null);
  const position = computed(() => {
    const id = selectedDetail.value?.session.id;
    const index = id ? sequence.value.indexOf(id) : -1;
    return { index, total: sequence.value.length };
  });

  watch(
    () => sessionsQuery.data.value?.pageInfo.page,
    (loadedPage) => {
      if (loadedPage !== undefined && sessionPage.value !== loadedPage) {
        sessionPage.value = loadedPage;
      }
    },
  );

  function setSessionsListActive(active: boolean): void {
    listActive.value = active;
    if (!active) return;
    sessionFilterError.value = dateRangeIsValid.value ? "" : "起始日期必須早於或等於結束日期。";
  }

  async function loadSessions(): Promise<void> {
    if (!dateRangeIsValid.value) {
      sessionFilterError.value = "起始日期必須早於或等於結束日期。";
      return;
    }
    sessionFilterError.value = "";
    try {
      const result = await sessionsQuery.refetch(true);
      if (result.status === "success" && sessionPage.value !== result.data.pageInfo.page) {
        sessionPage.value = result.data.pageInfo.page;
      }
    } catch (error) {
      if (!useApi().isAbortError(error)) throw error;
    }
  }

  function clearSessionFilters(): void {
    searchTerm.value = "";
    selectedProjectId.value = "";
    dateFrom.value = "";
    dateTo.value = "";
    voidedFilter.value = "exclude";
  }

  async function openSessionDetail(
    sessionId: string | undefined,
    failureMessage = "無法載入 Session detail。",
  ): Promise<void> {
    if (!sessionId) return;
    const previousId = selectedSessionId.value;
    selectedSessionId.value = sessionId;
    try {
      await detailQuery.refetch(true);
    } catch (error) {
      if (useApi().isAbortError(error)) return;
      if (selectedSessionId.value === sessionId) {
        selectedSessionId.value = previousId;
        useToast().showToast(errorMessage(error, failureMessage), "danger");
      }
    }
  }

  function closeSessionDetail(): void {
    selectedSessionId.value = null;
  }

  function setSessionSequence(ids: readonly string[]): void {
    sequence.value = [...ids];
  }

  function openAdjacentSession(step: 1 | -1): void {
    const { index } = position.value;
    const nextId = index >= 0 ? sequence.value[index + step] : undefined;
    void openSessionDetail(nextId);
  }

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
    voidedFilter,
    sessionFilterError,
    hasSessionFilters,
    selectedDetail,
    position,
    setSessionsListActive,
    loadSessions,
    clearSessionFilters,
    openSessionDetail,
    closeSessionDetail,
    setSessionSequence,
    openAdjacentSession,
  };
});

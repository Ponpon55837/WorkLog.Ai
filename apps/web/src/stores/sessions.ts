import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type {
  LinkSessionsResult,
  PageInfo,
  SessionLinkRelation,
  SessionDetail,
  SessionVoidedFilter,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  VerificationSummary,
  WorkSummarySections,
} from "@work-intelligence/core";
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

export type SessionEditorSaveInput = {
  sessionId: string;
  summary?: { idempotencyKey: string; value: string };
  workSummary?: { idempotencyKey: string; sections: Partial<WorkSummarySections> };
  verification?: VerificationSummary;
};

type SessionLinkInput = { sessionId: string; relatedSessionId: string; relation: SessionLinkRelation };
type EvidenceVoidMutationInput = SetEvidenceVoidInput & { sessionId: string };

function updateFailureMessage(result: { outcome: string; reason?: string }): string {
  return result.outcome === "not_found" ? "找不到這筆 Session。" : (result.reason ?? "無法更新 Session 摘要。");
}

/** Owns the filtered Session list query and its URL-backed view state. */
export const useSessionsStore = defineStore("sessions", () => {
  const queryCache = useQueryCache();
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
  const linkCandidatesEnabled = ref(false);
  const linkCandidateSourceId = ref("");
  const linkCandidateSearchTerm = ref("");
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
  const linkCandidatesQuery = useQuery({
    key: () => [
      ...queryKeys.sessions.linkCandidates,
      linkCandidateSourceId.value,
      linkCandidateSearchTerm.value.trim(),
    ],
    enabled: computed(() => linkCandidatesEnabled.value && Boolean(linkCandidateSourceId.value)),
    query: ({ signal }) =>
      useApi().client.listSessions({ q: linkCandidateSearchTerm.value.trim() || undefined, pageSize: 8 }, signal),
  });

  const saveSessionEditsMutation = useMutation({
    mutation: async (input: SessionEditorSaveInput) => {
      const { client } = useApi();
      if (input.summary) {
        const result = await client.updateSessionSummary({
          sessionId: input.sessionId,
          idempotencyKey: input.summary.idempotencyKey,
          mode: "replace",
          summary: input.summary.value,
        });
        if (result.outcome !== "summary_updated") {
          throw new Error(updateFailureMessage(result));
        }
      }
      if (input.workSummary) {
        const result = await client.updateSessionWorkSummary({
          sessionId: input.sessionId,
          idempotencyKey: input.workSummary.idempotencyKey,
          mode: "patch",
          workSummary: input.workSummary.sections,
        });
        if (result.outcome !== "work_summary_updated") {
          throw new Error(updateFailureMessage(result));
        }
      }
      if (input.verification) {
        const result = await client.updateSessionVerification(input.sessionId, input.verification);
        if (result.outcome !== "updated") {
          throw new Error(updateFailureMessage(result));
        }
      }
      return input.sessionId;
    },
    onSuccess: async (_sessionId, input) => {
      const invalidations = [
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.sessionId], exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.list, exact: true }),
      ];
      if (input.summary) {
        invalidations.push(
          queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
          queryCache.invalidateQueries({ key: queryKeys.commandPalette.search, exact: true }),
          queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
          queryCache.invalidateQueries({ key: queryKeys.views.knowledge, exact: true }),
        );
      }
      if (input.summary || input.workSummary || input.verification) {
        invalidations.push(queryCache.invalidateQueries({ key: queryKeys.views.reports, exact: true }));
      }
      await Promise.all(invalidations);
    },
  });
  const linkSessionsMutation = useMutation({
    mutation: (input: SessionLinkInput) =>
      useApi().client.linkSession(input.sessionId, input.relatedSessionId, input.relation),
    onSuccess: async (result, input) => {
      if (result.outcome !== "session_link_updated") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.sessionId], exact: true }),
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.relatedSessionId], exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
      ]);
    },
  });
  const unlinkSessionMutation = useMutation({
    mutation: (input: { sessionId: string; relatedSessionId: string }) =>
      useApi().client.unlinkSession(input.sessionId, input.relatedSessionId),
    onSuccess: async (result, input) => {
      if (result.outcome !== "session_link_updated") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.sessionId], exact: true }),
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.relatedSessionId], exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
      ]);
    },
  });
  const setSessionVoidMutation = useMutation({
    mutation: (input: SetSessionVoidInput) => useApi().client.setSessionVoid(input),
    onSuccess: async (result, input) => {
      if (result.outcome !== "session_void_updated") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.sessionId], exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.linkCandidates }),
        queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.commandPalette.search, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.reports, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.knowledge, exact: true }),
      ]);
    },
  });
  const setEvidenceVoidMutation = useMutation({
    mutation: ({ sessionId: _sessionId, ...input }: EvidenceVoidMutationInput) =>
      useApi().client.setEvidenceVoid(input),
    onSuccess: async (result, input) => {
      if (result.outcome !== "evidence_void_updated") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: [...queryKeys.sessions.detail, input.sessionId], exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.commandPalette.search, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.reports, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
      ]);
    },
  });

  const sessions = computed(() => sessionsQuery.data.value?.items ?? []);
  const sessionsLoading = computed(() => sessionsQuery.isLoading.value);
  const sessionsLoaded = computed(() => sessionsQuery.data.value !== undefined);
  const sessionPageInfo = computed(() => sessionsQuery.data.value?.pageInfo ?? { ...emptyPageInfo, pageSize: 10 });
  const selectedDetail = computed(() => detailQuery.data.value ?? null);
  const linkCandidates = computed(
    () => linkCandidatesQuery.data.value?.items.filter((item) => item.id !== linkCandidateSourceId.value) ?? [],
  );
  const linkCandidatesLoading = computed(() => linkCandidatesQuery.isLoading.value);
  const linkCandidatesError = computed(() =>
    linkCandidatesQuery.error.value ? errorMessage(linkCandidatesQuery.error.value, "無法搜尋 Session。") : "",
  );
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

  function openLinkCandidates(sourceId: string, searchTerm = ""): void {
    linkCandidateSourceId.value = sourceId;
    linkCandidateSearchTerm.value = searchTerm;
    linkCandidatesEnabled.value = true;
  }

  function searchLinkCandidates(searchTerm: string): void {
    linkCandidateSearchTerm.value = searchTerm;
  }

  function closeLinkCandidates(): void {
    linkCandidatesEnabled.value = false;
    linkCandidateSourceId.value = "";
    linkCandidateSearchTerm.value = "";
  }

  async function saveSessionEdits(input: SessionEditorSaveInput): Promise<void> {
    await saveSessionEditsMutation.mutateAsync(input);
  }

  async function linkSessions(input: SessionLinkInput): Promise<LinkSessionsResult> {
    return await linkSessionsMutation.mutateAsync(input);
  }

  async function unlinkSessions(input: { sessionId: string; relatedSessionId: string }): Promise<LinkSessionsResult> {
    return await unlinkSessionMutation.mutateAsync(input);
  }

  async function setSessionVoid(input: SetSessionVoidInput): Promise<SetSessionVoidResult> {
    return await setSessionVoidMutation.mutateAsync(input);
  }

  async function setEvidenceVoid(input: EvidenceVoidMutationInput): Promise<SetEvidenceVoidResult> {
    return await setEvidenceVoidMutation.mutateAsync(input);
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
    linkCandidates,
    linkCandidatesLoading,
    linkCandidatesError,
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
    saveSessionEdits,
    clearSessionFilters,
    openLinkCandidates,
    searchLinkCandidates,
    closeLinkCandidates,
    openSessionDetail,
    closeSessionDetail,
    setSessionSequence,
    openAdjacentSession,
    linkSessions,
    unlinkSessions,
    setSessionVoid,
    setEvidenceVoid,
  };
});

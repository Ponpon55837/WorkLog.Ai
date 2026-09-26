import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type {
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeAuditRecord,
  KnowledgeCandidate,
  KnowledgeCandidateListResult,
  KnowledgeHistoryResult,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeSearchResult,
  KnowledgeStatus,
  PageInfo,
  RequestKnowledgeCandidatesResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
} from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { pageSizeToQuery, type ListPageSize } from "../utils/labels";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

export type KnowledgeChanges = Partial<
  Pick<KnowledgeRecord, "kind" | "title" | "body" | "tags" | "references" | "status" | "appliesTo">
> & { confirm?: true };

const emptyPageInfo: PageInfo = {
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

type KnowledgeCandidateDecision = { input: DecideKnowledgeCandidateInput; projectRoot?: string };
type KnowledgeCandidateRequestInput = { projectRoot: string; refreshProjectRoot?: string };

/** Owns Knowledge records, audit history, Agent candidate queries, and their mutations. */
export const useKnowledgeStore = defineStore("knowledge", () => {
  const queryCache = useQueryCache();
  const listEnabled = ref(false);
  const knowledgePage = ref(1);
  const knowledgePageSize = ref<ListPageSize>(10);
  const knowledgeQuery = ref("");
  const knowledgeKind = ref<KnowledgeKind | "">("");
  const knowledgeProjectId = ref("");
  const knowledgeStatus = ref<KnowledgeStatus>("active");
  const historyKnowledgeId = ref("");
  const historyProjectRoot = ref("");
  const historyEnabled = ref(false);
  const candidateProjectRoot = ref<string | undefined>();
  const candidatesEnabled = ref(false);
  const candidatesLoadingState = ref(false);

  const listQuery = useQuery({
    key: queryKeys.knowledge.list,
    enabled: listEnabled,
    query: ({ signal }): Promise<KnowledgeSearchResult> =>
      useApi().client.searchKnowledge(
        {
          q: knowledgeQuery.value.trim() || undefined,
          kind: knowledgeKind.value || undefined,
          projectId: knowledgeProjectId.value || undefined,
          status: knowledgeStatus.value,
          page: knowledgePage.value,
          pageSize: knowledgePageSize.value,
        },
        signal,
      ),
  });
  const historyQuery = useQuery({
    key: () => [...queryKeys.knowledge.history, historyKnowledgeId.value, historyProjectRoot.value],
    enabled: computed(() => historyEnabled.value && Boolean(historyKnowledgeId.value && historyProjectRoot.value)),
    query: ({ signal }): Promise<KnowledgeHistoryResult> => {
      if (!historyKnowledgeId.value || !historyProjectRoot.value) {
        throw new Error("Knowledge history needs a Knowledge ID and tracked project root.");
      }
      return useApi().client.getKnowledgeHistory(
        historyKnowledgeId.value,
        { projectRoot: historyProjectRoot.value, limit: 100 },
        signal,
      );
    },
  });
  const candidatesQuery = useQuery({
    key: () => [...queryKeys.knowledge.candidates, candidateProjectRoot.value ?? "all"],
    enabled: candidatesEnabled,
    query: ({ signal }): Promise<KnowledgeCandidateListResult> =>
      useApi().client.listKnowledgeCandidates(candidateProjectRoot.value, signal),
  });

  const updateKnowledgeMutation = useMutation({
    mutation: (input: UpdateKnowledgeInput) => useApi().client.updateKnowledge(input.knowledgeId, input),
    onSuccess: async (result, input) => {
      if (result.outcome !== "knowledge_updated") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.knowledge.list, exact: true }),
        queryCache.invalidateQueries({ key: [...queryKeys.knowledge.history, input.knowledgeId] }),
        queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
      ]);
    },
  });
  const requestKnowledgeCandidatesMutation = useMutation({
    mutation: (input: KnowledgeCandidateRequestInput) => useApi().client.requestKnowledgeCandidates(input.projectRoot),
    onSuccess: async (_result, input) => {
      await queryCache.invalidateQueries({
        key: [...queryKeys.knowledge.candidates, input.refreshProjectRoot ?? "all"],
        exact: true,
      });
    },
  });
  const decideKnowledgeCandidateMutation = useMutation({
    mutation: ({ input }: KnowledgeCandidateDecision) => useApi().client.decideKnowledgeCandidate(input),
    onSuccess: async (result, variables) => {
      if (result.outcome !== "knowledge_candidate_decided" && result.outcome !== "already_decided") return;
      const invalidations = [
        queryCache.invalidateQueries({
          key: [...queryKeys.knowledge.candidates, variables.projectRoot ?? "all"],
          exact: true,
        }),
      ];
      if (variables.input.decision === "accept") {
        invalidations.push(queryCache.invalidateQueries({ key: queryKeys.knowledge.list, exact: true }));
      }
      if (result.outcome === "knowledge_candidate_decided" && result.knowledge) {
        invalidations.push(
          queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
          queryCache.invalidateQueries({ key: queryKeys.views.graph, exact: true }),
        );
      }
      await Promise.all(invalidations);
    },
  });

  const knowledgeItems = computed(() =>
    listQuery.data.value?.outcome === "knowledge" ? listQuery.data.value.items : [],
  );
  const knowledgeProjects = computed(() =>
    listQuery.data.value?.outcome === "knowledge" ? listQuery.data.value.projects : [],
  );
  const knowledgePageInfo = computed(() =>
    listQuery.data.value?.outcome === "knowledge"
      ? listQuery.data.value.pageInfo
      : { ...emptyPageInfo, pageSize: pageSizeToQuery(knowledgePageSize.value) },
  );
  const knowledgeLoading = computed(() => listQuery.isLoading.value);
  const knowledgeError = computed(() => {
    if (listQuery.error.value) return errorMessage(listQuery.error.value, "無法載入 Knowledge。");
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? result.reason : "";
  });
  const knowledgeHistory = computed<KnowledgeAuditRecord[]>(() =>
    historyQuery.data.value?.outcome === "knowledge_history" ? historyQuery.data.value.history : [],
  );
  const knowledgeHistoryLoading = computed(() => historyQuery.isLoading.value);
  const knowledgeHistoryError = computed(() => {
    if (historyQuery.error.value) return errorMessage(historyQuery.error.value, "無法載入 Knowledge 變更紀錄。");
    const result = historyQuery.data.value;
    if (result?.outcome === "skipped") return result.reason;
    return result?.outcome === "not_found" ? "這筆 Knowledge 已不存在。" : "";
  });
  const candidates = computed<KnowledgeCandidate[]>(() =>
    candidatesQuery.data.value?.outcome === "knowledge_candidates" ? candidatesQuery.data.value.items : [],
  );
  const openCandidateRequests = computed(() =>
    candidatesQuery.data.value?.outcome === "knowledge_candidates" ? candidatesQuery.data.value.openRequests : [],
  );
  const candidatesError = computed(() =>
    candidatesQuery.error.value ? errorMessage(candidatesQuery.error.value, "無法載入 Knowledge 候選。") : "",
  );
  const candidatesLoading = computed(() => candidatesLoadingState.value);

  watch(
    () => (listQuery.data.value?.outcome === "knowledge" ? listQuery.data.value.pageInfo.page : undefined),
    (loadedPage) => {
      if (loadedPage !== undefined && knowledgePage.value !== loadedPage) knowledgePage.value = loadedPage;
    },
  );

  async function loadKnowledge(): Promise<void> {
    listEnabled.value = true;
    try {
      await listQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) return;
    }
  }

  async function updateKnowledge(input: UpdateKnowledgeInput): Promise<UpdateKnowledgeResult> {
    return await updateKnowledgeMutation.mutateAsync(input);
  }

  async function loadKnowledgeHistory(knowledgeId: string, projectRoot: string): Promise<void> {
    historyKnowledgeId.value = knowledgeId;
    historyProjectRoot.value = projectRoot;
    historyEnabled.value = true;
    try {
      await historyQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) return;
    }
  }

  function closeKnowledgeHistory(): void {
    historyEnabled.value = false;
    historyKnowledgeId.value = "";
    historyProjectRoot.value = "";
  }

  async function loadCandidates(projectRoot?: string, quiet = false): Promise<void> {
    candidateProjectRoot.value = projectRoot;
    candidatesEnabled.value = true;
    if (!quiet) candidatesLoadingState.value = true;
    try {
      await candidatesQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) return;
    } finally {
      if (!quiet) candidatesLoadingState.value = false;
    }
  }

  async function requestKnowledgeCandidates(
    projectRoot: string,
    refreshProjectRoot?: string,
  ): Promise<RequestKnowledgeCandidatesResult> {
    return await requestKnowledgeCandidatesMutation.mutateAsync({ projectRoot, refreshProjectRoot });
  }

  async function decideKnowledgeCandidate(
    input: DecideKnowledgeCandidateInput,
    projectRoot?: string,
  ): Promise<DecideKnowledgeCandidateResult> {
    return await decideKnowledgeCandidateMutation.mutateAsync({ input, projectRoot });
  }

  return {
    knowledgeItems,
    knowledgeProjects,
    knowledgePage,
    knowledgePageSize,
    knowledgePageInfo,
    knowledgeQuery,
    knowledgeKind,
    knowledgeProjectId,
    knowledgeStatus,
    knowledgeLoading,
    knowledgeError,
    loadKnowledge,
    updateKnowledge,
    knowledgeHistory,
    knowledgeHistoryLoading,
    knowledgeHistoryError,
    loadKnowledgeHistory,
    closeKnowledgeHistory,
    candidates,
    openCandidateRequests,
    candidatesLoading,
    candidatesError,
    loadCandidates,
    requestKnowledgeCandidates,
    decideKnowledgeCandidate,
  };
});

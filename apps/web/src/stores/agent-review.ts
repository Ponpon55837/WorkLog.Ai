import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import type {
  AgentReviewedKnowledge,
  AgentReviewedKnowledgeListResult,
  AgentReviewRequest,
  AgentReviewRequestListResult,
  CreateAgentReviewRequestInput,
  KnowledgeCandidate,
  KnowledgeCandidateListResult,
  OverturnAgentReviewInput,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

export type AgentReviewListFilter = "pending" | "agent";

const OPEN_STATUSES: readonly AgentReviewRequest["status"][] = ["pending", "processing", "failed"];

export const useAgentReviewStore = defineStore("agent-review", () => {
  const queryCache = useQueryCache();
  const active = ref(false);
  const filter = ref<AgentReviewListFilter>("pending");
  const projectId = ref("");
  const knowledgeActive = ref(false);
  const projectRoot = ref<string | undefined>();
  const createKey = ref("");

  const requestsQuery = useQuery<AgentReviewRequestListResult>({
    key: () => [...queryKeys.agentReview.requests, { projectId: projectId.value }],
    enabled: () => active.value && Boolean(projectId.value),
    query: ({ signal }) =>
      useApi().client.listAgentReviewRequests({ projectId: projectId.value, page: 1, pageSize: 1 }, signal),
  });
  const completedRequestQuery = useQuery<AgentReviewRequestListResult>({
    key: () => [...queryKeys.agentReview.requests, { projectId: projectId.value, status: "completed" }],
    enabled: () => active.value && Boolean(projectId.value),
    query: ({ signal }) =>
      useApi().client.listAgentReviewRequests(
        { projectId: projectId.value, status: "completed", page: 1, pageSize: 1 },
        signal,
      ),
  });
  const reviewedCandidatesQuery = useQuery<KnowledgeCandidateListResult>({
    key: () => [...queryKeys.agentReview.candidates, projectRoot.value ?? "all"],
    enabled: () => active.value && filter.value === "agent",
    query: ({ signal }) => useApi().client.listKnowledgeCandidates(projectRoot.value, signal, "agent"),
  });
  const reviewedKnowledgeQuery = useQuery<AgentReviewedKnowledgeListResult>({
    key: () => [...queryKeys.agentReview.knowledge, projectRoot.value ?? "all"],
    enabled: () => active.value && knowledgeActive.value,
    query: ({ signal }) => useApi().client.listAgentReviewedKnowledge(projectRoot.value, signal),
  });

  const createMutation = useMutation({
    mutation: (input: CreateAgentReviewRequestInput) => useApi().client.createAgentReviewRequest(input),
    onSuccess: () =>
      Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.agentReview.requests }),
      ]),
  });
  const cancelMutation = useMutation({
    mutation: (requestId: string) => useApi().client.cancelAgentReviewRequest(requestId),
    onSuccess: () =>
      Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.agentReview.requests }),
      ]),
  });
  const overturnMutation = useMutation({
    mutation: (input: OverturnAgentReviewInput) => useApi().client.overturnAgentReview(input),
    onSuccess: async (result) => {
      if (result.outcome !== "agent_review_overturned") return;
      // Refreshes can be superseded by SSE; their errors do not undo the committed overturn.
      await Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.agentReview.requests }),
        queryCache.invalidateQueries({ key: queryKeys.sessionDecisions.list }),
        queryCache.invalidateQueries({ key: queryKeys.knowledge.candidates }),
        queryCache.invalidateQueries({ key: queryKeys.knowledge.list }),
        queryCache.invalidateQueries({ key: queryKeys.agentReview.knowledge }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
        queryCache.invalidateQueries({ key: queryKeys.reports.report }),
        queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph }),
      ]);
    },
  });

  const latestRequest = computed<AgentReviewRequest | undefined>(() => {
    const result = requestsQuery.data.value;
    const request = result?.outcome === "agent_review_requests" ? result.requests[0] : undefined;
    return request && request.projectId === projectId.value && request.status !== "cancelled" ? request : undefined;
  });
  const latestCompletedRequest = computed<AgentReviewRequest | undefined>(() => {
    const result = completedRequestQuery.data.value;
    const request = result?.outcome === "agent_review_requests" ? result.requests[0] : undefined;
    return request && request.projectId === projectId.value && request.status === "completed" ? request : undefined;
  });
  const hasOpenRequest = computed(() =>
    Boolean(latestRequest.value && OPEN_STATUSES.includes(latestRequest.value.status)),
  );
  const requestLoaded = computed(() => requestsQuery.data.value !== undefined);
  const requestError = computed(() =>
    requestsQuery.error.value ? errorMessage(requestsQuery.error.value, t("knowledge.couldNotLoadAgentReview")) : "",
  );
  const skipped = computed(() => requestsQuery.data.value?.outcome === "skipped");
  const reviewedCandidates = computed<KnowledgeCandidate[]>(() =>
    reviewedCandidatesQuery.data.value?.outcome === "knowledge_candidates"
      ? reviewedCandidatesQuery.data.value.items
      : [],
  );
  const reviewedCandidatesLoaded = computed(() => reviewedCandidatesQuery.data.value !== undefined);
  const reviewedCandidatesLoading = computed(() => reviewedCandidatesQuery.isLoading.value);
  const reviewedCandidatesError = computed(() =>
    reviewedCandidatesQuery.error.value
      ? errorMessage(reviewedCandidatesQuery.error.value, t("knowledge.couldNotLoadKnowledgeCandidates"))
      : "",
  );
  const reviewedKnowledge = computed<AgentReviewedKnowledge[]>(() =>
    reviewedKnowledgeQuery.data.value?.outcome === "agent_reviewed_knowledge"
      ? reviewedKnowledgeQuery.data.value.items
      : [],
  );
  const reviewedKnowledgeLoaded = computed(() => reviewedKnowledgeQuery.data.value !== undefined);
  const reviewedKnowledgeError = computed(() =>
    reviewedKnowledgeQuery.error.value
      ? errorMessage(reviewedKnowledgeQuery.error.value, t("knowledge.couldNotLoadAgentReviewedKnowledge"))
      : "",
  );

  function setScope(nextProjectId: string, nextProjectRoot: string | undefined): void {
    if (projectId.value !== nextProjectId) createKey.value = "";
    projectId.value = nextProjectId;
    projectRoot.value = nextProjectRoot;
  }

  function setActive(value: boolean): void {
    active.value = value;
  }

  function setKnowledgeActive(value: boolean): void {
    knowledgeActive.value = value;
  }

  /** A retry after a failed attempt reuses the key, so the server never opens two requests for one click. */
  async function createRequest() {
    createKey.value ||= crypto.randomUUID();
    const result = await createMutation.mutateAsync({ projectId: projectId.value, idempotencyKey: createKey.value });
    createKey.value = "";
    return result;
  }

  async function cancelRequest(requestId: string) {
    return cancelMutation.mutateAsync(requestId);
  }

  async function overturn(input: OverturnAgentReviewInput) {
    return overturnMutation.mutateAsync(input);
  }

  return {
    active,
    filter,
    projectId,
    projectRoot,
    latestRequest,
    latestCompletedRequest,
    hasOpenRequest,
    requestLoaded,
    requestError,
    skipped,
    reviewedCandidates,
    reviewedCandidatesLoaded,
    reviewedCandidatesLoading,
    reviewedCandidatesError,
    reviewedKnowledge,
    reviewedKnowledgeLoaded,
    reviewedKnowledgeError,
    setScope,
    setActive,
    setKnowledgeActive,
    createRequest,
    cancelRequest,
    overturn,
  };
});

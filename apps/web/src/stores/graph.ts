import { computed, nextTick, ref, watch } from "vue";
import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import type { GraphNode, GraphQuery, GraphQueryResult, GraphResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";

export type GraphNodeFilter = GraphNode["kind"] | "all";

export const graphLoadPresetOptions = [
  { value: "180", label: "180 節點 / 360 關係", maxNodes: 180, maxEdges: 360 },
  { value: "300", label: "300 節點 / 720 關係", maxNodes: 300, maxEdges: 720 },
  { value: "500", label: "500 節點 / 1,000 關係", maxNodes: 500, maxEdges: 1_000 },
] as const;

function graphPreset(value: string) {
  return graphLoadPresetOptions.find((preset) => preset.value === value) ?? graphLoadPresetOptions[0];
}

function graphRequestOptions(projectId: string, presetValue: string, cursor?: string): GraphQuery {
  const preset = graphPreset(presetValue);
  return {
    projectId: projectId || undefined,
    limit: 200,
    maxNodes: preset.maxNodes,
    maxEdges: preset.maxEdges,
    pageSize: preset.maxNodes,
    cursor,
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const uniqueItems = new Map<string, T>();
  for (const item of items) {
    if (!uniqueItems.has(item.id)) uniqueItems.set(item.id, item);
  }
  return [...uniqueItems.values()];
}

/** Owns Graph filters, paged REST data, query status, and selected-node state. */
export const useGraphStore = defineStore("graph", () => {
  const graphActive = ref(false);
  const graphProjectId = ref("");
  const graphNodeFilter = ref<GraphNodeFilter>("all");
  const graphPreviewLimit = ref(120);
  const graphLoadPreset = ref("180");
  const graphSearch = ref("");
  const selectedGraphNode = ref<GraphNode | null>(null);
  const graphPanelWidth = ref(460);
  const graphPageCursor = ref<string | undefined>();
  const graphExtraPages = ref<GraphResult[]>([]);
  const graphRequestError = ref("");
  const graphGeneration = ref(0);

  const graphQuery = useQuery({
    key: () => [...queryKeys.views.graph, graphProjectId.value || "all", graphLoadPreset.value, "first"],
    enabled: graphActive,
    refetchOnMount: "always",
    query: ({ signal }): Promise<GraphQueryResult> =>
      useApi().client.getGraph(graphRequestOptions(graphProjectId.value, graphLoadPreset.value), signal),
  });
  const graphPageQuery = useQuery({
    key: () => [
      ...queryKeys.views.graph,
      graphProjectId.value || "all",
      graphLoadPreset.value,
      "cursor",
      graphPageCursor.value ?? "none",
    ],
    enabled: false,
    query: ({ signal }): Promise<GraphQueryResult> => {
      const cursor = graphPageCursor.value;
      if (!cursor) throw new Error("A Graph cursor is required before loading another page.");
      return useApi().client.getGraph(graphRequestOptions(graphProjectId.value, graphLoadPreset.value, cursor), signal);
    },
  });

  const graphError = computed(() => {
    if (graphRequestError.value) return graphRequestError.value;
    if (graphQuery.error.value) return errorMessage(graphQuery.error.value, "無法載入工作圖譜。");
    if (graphPageQuery.error.value) return errorMessage(graphPageQuery.error.value, "無法載入工作圖譜。");
    const firstPage = graphQuery.data.value;
    if (firstPage?.outcome === "skipped") return firstPage.reason;
    const currentPage = graphPageQuery.data.value;
    return currentPage?.outcome === "skipped" ? currentPage.reason : "";
  });
  const graph = computed<GraphResult | null>(() => {
    const firstPage = graphQuery.data.value;
    if (graphError.value || firstPage?.outcome !== "graph") return null;

    const pages = [firstPage, ...graphExtraPages.value];
    const lastPage = pages.at(-1) ?? firstPage;
    return {
      ...lastPage,
      nodes: uniqueById(pages.flatMap((page) => page.nodes)),
      edges: uniqueById(pages.flatMap((page) => page.edges)),
      projects: firstPage.projects,
      sourceProjectIds: [...new Set(pages.flatMap((page) => page.sourceProjectIds))],
      sourceSessionIds: [...new Set(pages.flatMap((page) => page.sourceSessionIds))],
    };
  });
  const graphLoading = computed(() => graphQuery.isLoading.value || graphPageQuery.isLoading.value);
  const graphCanLoadMore = computed(() => Boolean(graph.value?.nextCursor));

  function resetGraphPages(): void {
    graphGeneration.value += 1;
    graphExtraPages.value = [];
    graphPageCursor.value = undefined;
    graphRequestError.value = "";
  }

  watch([graphProjectId, graphLoadPreset], resetGraphPages);
  watch(
    () => graphQuery.data.value,
    (page, previousPage) => {
      if (page !== previousPage && previousPage !== undefined) resetGraphPages();
    },
  );

  function setGraphActive(active: boolean): void {
    graphActive.value = active;
  }

  async function loadGraph(): Promise<void> {
    resetGraphPages();
    graphActive.value = true;
    try {
      await graphQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        graphRequestError.value = errorMessage(error, "無法載入工作圖譜。");
      }
    }
  }

  async function loadMoreGraph(): Promise<void> {
    const cursor = graph.value?.nextCursor;
    if (!cursor) {
      useToast().showToast("圖譜已載入完成。");
      return;
    }

    const generation = graphGeneration.value;
    graphRequestError.value = "";
    graphPageCursor.value = cursor;
    await nextTick();
    try {
      const result = await graphPageQuery.refetch(true);
      if (generation !== graphGeneration.value || result.status !== "success") return;
      if (result.data.outcome !== "graph") {
        graphRequestError.value = result.data.reason;
        return;
      }
      graphExtraPages.value = [...graphExtraPages.value, result.data];
    } catch (error) {
      if (generation === graphGeneration.value && !useApi().isAbortError(error)) {
        graphRequestError.value = errorMessage(error, "無法載入工作圖譜。");
      }
    }
  }

  function selectGraphNode(node: GraphNode | null): void {
    selectedGraphNode.value = node;
  }

  return {
    graph,
    graphProjectId,
    graphNodeFilter,
    graphPreviewLimit,
    graphLoadPreset,
    graphSearch,
    graphLoading,
    graphError,
    graphCanLoadMore,
    selectedGraphNode,
    graphPanelWidth,
    loadGraph,
    loadMoreGraph,
    setGraphActive,
    selectGraphNode,
  };
});

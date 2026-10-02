import { computed, nextTick, ref, watch } from "vue";
import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import type { GraphNode, GraphPathResult, GraphQuery, GraphQueryResult, GraphResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

export type GraphNodeFilter = GraphNode["kind"] | "all";

export const graphLoadPresetOptions = [
  { value: "180", label: "180 節點 / 360 關係", maxNodes: 180, maxEdges: 360 },
  { value: "300", label: "300 節點 / 720 關係", maxNodes: 300, maxEdges: 720 },
  { value: "500", label: "500 節點 / 1,000 關係", maxNodes: 500, maxEdges: 1_000 },
] as const;

function graphPreset(value: string) {
  return graphLoadPresetOptions.find((preset) => preset.value === value) ?? graphLoadPresetOptions[0];
}

function graphRequestOptions(
  projectId: string,
  presetValue: string,
  includeDerived: boolean,
  cursor?: string,
): GraphQuery {
  const preset = graphPreset(presetValue);
  return {
    projectId: projectId || undefined,
    limit: 200,
    maxNodes: preset.maxNodes,
    maxEdges: preset.maxEdges,
    pageSize: preset.maxNodes,
    cursor,
    ...(includeDerived ? { includeDerived } : {}),
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
  /** Derived co_changed edges are hidden until the viewer turns them on. */
  const graphShowDerived = ref(false);
  const graphPathEnds = ref<{ from: string; to: string } | null>(null);

  const graphQuery = useQuery({
    key: () => [
      ...queryKeys.views.graph,
      graphProjectId.value || "all",
      graphLoadPreset.value,
      graphShowDerived.value,
      "first",
    ],
    enabled: graphActive,
    refetchOnMount: "always",
    query: ({ signal }): Promise<GraphQueryResult> =>
      useApi().client.getGraph(
        graphRequestOptions(graphProjectId.value, graphLoadPreset.value, graphShowDerived.value),
        signal,
      ),
  });
  const graphPageQuery = useQuery({
    key: () => [
      ...queryKeys.views.graph,
      graphProjectId.value || "all",
      graphLoadPreset.value,
      graphShowDerived.value,
      "cursor",
      graphPageCursor.value ?? "none",
    ],
    enabled: false,
    query: ({ signal }): Promise<GraphQueryResult> => {
      const cursor = graphPageCursor.value;
      if (!cursor) throw new Error("A Graph cursor is required before loading another page.");
      return useApi().client.getGraph(
        graphRequestOptions(graphProjectId.value, graphLoadPreset.value, graphShowDerived.value, cursor),
        signal,
      );
    },
  });
  const graphPathQuery = useQuery({
    key: () => [
      ...queryKeys.views.graph,
      "path",
      graphProjectId.value || "all",
      graphShowDerived.value,
      graphPathEnds.value?.from ?? "",
      graphPathEnds.value?.to ?? "",
    ],
    enabled: () => Boolean(graphPathEnds.value),
    query: ({ signal }): Promise<GraphPathResult> =>
      useApi().client.getGraphPath(
        {
          projectId: graphProjectId.value || undefined,
          from: graphPathEnds.value!.from,
          to: graphPathEnds.value!.to,
          includeDerived: graphShowDerived.value || undefined,
        },
        signal,
      ),
  });

  const graphError = computed(() => {
    if (graphRequestError.value) return graphRequestError.value;
    if (graphQuery.error.value) return errorMessage(graphQuery.error.value, t("無法載入工作圖譜。"));
    if (graphPageQuery.error.value) return errorMessage(graphPageQuery.error.value, t("無法載入工作圖譜。"));
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
  const graphPath = computed(() =>
    graphPathEnds.value && graphPathQuery.data.value?.outcome === "graph_path" ? graphPathQuery.data.value : null,
  );
  const graphPathLoading = computed(() => graphPathQuery.isLoading.value);
  const graphPathError = computed(() => {
    if (graphPathQuery.error.value) return errorMessage(graphPathQuery.error.value, t("無法找出兩個節點的關聯。"));
    const result = graphPathQuery.data.value;
    return result?.outcome === "skipped" ? result.reason : "";
  });
  /** Edge ids on the current path, for highlighting. */
  const graphPathEdgeIds = computed(() => new Set(graphPath.value?.steps.map((step) => step.edge.id) ?? []));
  const graphCanLoadMore = computed(() => Boolean(graph.value?.nextCursor));

  function resetGraphPages(): void {
    graphGeneration.value += 1;
    graphExtraPages.value = [];
    graphPageCursor.value = undefined;
    graphRequestError.value = "";
  }

  watch([graphProjectId, graphLoadPreset, graphShowDerived], resetGraphPages);
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
        graphRequestError.value = errorMessage(error, t("無法載入工作圖譜。"));
      }
    }
  }

  async function loadMoreGraph(): Promise<void> {
    const cursor = graph.value?.nextCursor;
    if (!cursor) {
      useToast().showToast(t("圖譜已載入完成。"));
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
        graphRequestError.value = errorMessage(error, t("無法載入工作圖譜。"));
      }
    }
  }

  function selectGraphNode(node: GraphNode | null): void {
    selectedGraphNode.value = node;
  }

  function findGraphPath(from: string, to: string): void {
    graphPathEnds.value = { from, to };
  }

  function clearGraphPath(): void {
    graphPathEnds.value = null;
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
    graphShowDerived,
    graphPath,
    graphPathLoading,
    graphPathError,
    graphPathEdgeIds,
    loadGraph,
    loadMoreGraph,
    setGraphActive,
    selectGraphNode,
    findGraphPath,
    clearGraphPath,
  };
});

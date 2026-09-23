import { computed, ref } from "vue";
import type { GraphEdge, GraphNode, GraphQueryResult, ProjectStatus, ReportVerificationStatus } from "@work-intelligence/core";
import { router } from "../router";
import { graphEdgeKindLabels, graphMetadataLabels, graphNodeKindLabels, graphNodeKindOrder, statusLabels, verificationLabels } from "../utils/labels";
import { errorMessage, formatDate } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useKnowledge } from "./useKnowledge";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

export type GraphNodeFilter = GraphNode["kind"] | "all";
export type GraphVisualNode = { node: GraphNode; x: number; y: number };
export type GraphVisualEdge = { edge: GraphEdge; from: GraphVisualNode; to: GraphVisualNode };
type GraphNodeRelation = { edge: GraphEdge; direction: "incoming" | "outgoing"; relatedNode: GraphNode };

export const graphLoadPresetOptions = [
  { value: "180", label: "180 節點 / 360 關係", maxNodes: 180, maxEdges: 360 },
  { value: "300", label: "300 節點 / 720 關係", maxNodes: 300, maxEdges: 720 },
  { value: "500", label: "500 節點 / 1,000 關係", maxNodes: 500, maxEdges: 1_000 }
] as const;

const graphVisualBaseQuotas: Record<GraphNode["kind"], number> = {
  project: 8,
  session: 24,
  knowledge: 18,
  evidence: 18,
  file: 48
};

const graph = ref<Extract<GraphQueryResult, { outcome: "graph" }> | null>(null);
const graphProjectId = ref("");
const graphNodeFilter = ref<GraphNodeFilter>("all");
const graphPreviewLimit = ref(120);
const graphLoadPreset = ref("180");
const graphLoading = ref(false);
const graphError = ref("");
const selectedGraphNode = ref<GraphNode | null>(null);

async function loadGraph(cursor?: string): Promise<void> {
  graphLoading.value = true;
  graphError.value = "";
  const loadPreset = graphLoadPresetOptions.find((preset) => preset.value === graphLoadPreset.value) ?? graphLoadPresetOptions[0];
  await runKeyed(
    "graph",
    async (signal) => {
      const result = await useApi().client.getGraph({
        projectId: graphProjectId.value || undefined,
        limit: 200,
        maxNodes: loadPreset.maxNodes,
        maxEdges: loadPreset.maxEdges,
        pageSize: loadPreset.maxNodes,
        cursor
      }, signal);
      if (result.outcome !== "graph") {
        graph.value = null;
        graphError.value = result.reason;
        return;
      }
      const previous = graph.value;
      if (cursor && previous) {
        const nodes = [...previous.nodes, ...result.nodes].filter((node, index, items) => items.findIndex((candidate) => candidate.id === node.id) === index);
        const edges = [...previous.edges, ...result.edges].filter((edge, index, items) => items.findIndex((candidate) => candidate.id === edge.id) === index);
        graph.value = {
          ...result,
          nodes,
          edges,
          projects: previous.projects,
          sourceProjectIds: [...new Set([...previous.sourceProjectIds, ...result.sourceProjectIds])],
          sourceSessionIds: [...new Set([...previous.sourceSessionIds, ...result.sourceSessionIds])]
        };
      } else {
        graph.value = result;
      }
    },
    {
      onError: (error) => {
        graph.value = null;
        graphError.value = errorMessage(error, "無法載入工作圖譜。");
      },
      onSettled: () => {
        graphLoading.value = false;
      }
    }
  );
}

async function loadMoreGraph(): Promise<void> {
  const cursor = graph.value?.nextCursor;
  if (!cursor) {
    useToast().showToast("圖譜已載入完成。");
    return;
  }
  await loadGraph(cursor);
}

const graphVisualQuotas = computed<Record<GraphNode["kind"], number>>(() => {
  const baseTotal = Object.values(graphVisualBaseQuotas).reduce((total, quota) => total + quota, 0);
  const quotas = {} as Record<GraphNode["kind"], number>;
  let allocated = 0;
  graphNodeKindOrder.forEach((kind, index) => {
    if (index === graphNodeKindOrder.length - 1) {
      quotas[kind] = Math.max(1, graphPreviewLimit.value - allocated);
      return;
    }
    const quota = Math.max(1, Math.floor((graphVisualBaseQuotas[kind] / baseTotal) * graphPreviewLimit.value));
    quotas[kind] = quota;
    allocated += quota;
  });
  return quotas;
});

const graphVisual = computed(() => {
  if (!graph.value) {
    return { width: 1_120, height: 560, nodes: [] as GraphVisualNode[], edges: [] as GraphVisualEdge[], hiddenNodes: 0, hiddenEdges: 0 };
  }

  const filteredNodes = graphNodeFilter.value === "all"
    ? graph.value.nodes
    : graph.value.nodes.filter((node) => node.kind === graphNodeFilter.value);
  const visibleNodes = graphNodeFilter.value === "all"
    ? graphNodeKindOrder.flatMap((kind) => filteredNodes.filter((node) => node.kind === kind).slice(0, graphVisualQuotas.value[kind]))
    : filteredNodes.slice(0, graphPreviewLimit.value);
  const hiddenNodeIds = new Set(filteredNodes.map((node) => node.id));
  visibleNodes.forEach((node) => hiddenNodeIds.delete(node.id));
  const laneIndex = new Map<GraphNode["kind"], number>(graphNodeKindOrder.map((kind, index) => [kind, index]));
  const laneNodes = new Map<GraphNode["kind"], GraphNode[]>(
    graphNodeKindOrder.map((kind) => [kind, visibleNodes.filter((node) => node.kind === kind)])
  );
  const positions = new Map<string, GraphVisualNode>();
  const laneTop = 48;
  const rowHeight = 58;
  graphNodeKindOrder.forEach((kind) => {
    (laneNodes.get(kind) ?? []).forEach((node, index) => {
      positions.set(node.id, { node, x: 110 + (laneIndex.get(kind) ?? 0) * 220, y: laneTop + index * rowHeight });
    });
  });

  const graphEdges = graph.value.edges.reduce<GraphVisualEdge[]>((items, edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from && to) {
      items.push({ edge, from, to });
    }
    return items;
  }, []);
  const rows = Math.max(...graphNodeKindOrder.map((kind) => laneNodes.get(kind)?.length ?? 0), 1);
  return {
    width: 1_120,
    height: Math.max(560, laneTop + rows * rowHeight + 55),
    nodes: visibleNodes.map((node) => positions.get(node.id)).filter((node): node is GraphVisualNode => Boolean(node)),
    edges: graphEdges,
    hiddenNodes: hiddenNodeIds.size,
    hiddenEdges: graph.value.edges.length - graphEdges.length
  };
});

const graphFilteredTotalNodes = computed(() => {
  if (!graph.value) {
    return 0;
  }
  return graphNodeFilter.value === "all" ? graph.value.totalNodes : graph.value.totalNodesByKind[graphNodeFilter.value];
});

const graphCanLoadMore = computed(() => Boolean(graph.value?.nextCursor));

const graphNodeCounts = computed(() => {
  const totals = graph.value?.totalNodesByKind ?? { project: 0, session: 0, knowledge: 0, evidence: 0, file: 0 };
  return graphNodeKindOrder.map((kind) => ({ kind, label: graphNodeKindLabels[kind], count: totals[kind] }));
});

const graphEdgeCounts = computed(() => {
  const edges = graph.value?.edges ?? [];
  return (Object.keys(graphEdgeKindLabels) as Array<keyof typeof graphEdgeKindLabels>).map((kind) => ({
    kind,
    label: graphEdgeKindLabels[kind],
    count: edges.filter((edge) => edge.kind === kind).length
  }));
});

function graphNodeDescription(node: GraphNode): string {
  if (node.kind === "session") {
    return `${String(node.metadata.verification ?? "not_supplied")} · ${String(node.metadata.changedFilesCount ?? 0)} files`;
  }
  if (node.kind === "knowledge") {
    return String(node.metadata.kind ?? "knowledge");
  }
  if (node.kind === "evidence") {
    return String(node.metadata.kind ?? "evidence");
  }
  if (node.kind === "file") {
    return "changed file";
  }
  return String(node.metadata.status ?? "tracked");
}

function formatGraphMetadataValue(key: string, value: string | number | boolean): string {
  if (key === "status" && typeof value === "string" && value in statusLabels) {
    return statusLabels[value as ProjectStatus];
  }
  if (key === "verification" && typeof value === "string" && value in verificationLabels) {
    return verificationLabels[value as ReportVerificationStatus];
  }
  if ((key === "completedAt" || key === "capturedAt") && typeof value === "string") {
    return formatDate(value);
  }
  if (key === "changedFilesCount") {
    return `${value} 個檔案`;
  }
  if (key === "tagsCount") {
    return `${value} 個標籤`;
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return String(value);
}

const selectedGraphNodeMetadata = computed(() => {
  if (!selectedGraphNode.value) {
    return [];
  }
  return Object.entries(selectedGraphNode.value.metadata).map(([key, value]) => ({
    key,
    label: graphMetadataLabels[key] ?? key,
    value: formatGraphMetadataValue(key, value)
  }));
});

const selectedGraphNodeRelations = computed<GraphNodeRelation[]>(() => {
  const node = selectedGraphNode.value;
  if (!node || !graph.value) {
    return [];
  }
  const nodesById = new Map(graph.value.nodes.map((candidate) => [candidate.id, candidate]));
  return graph.value.edges.flatMap((edge): GraphNodeRelation[] => {
    const isOutgoing = edge.from === node.id;
    if (!isOutgoing && edge.to !== node.id) {
      return [];
    }
    const relatedNode = nodesById.get(isOutgoing ? edge.to : edge.from);
    return relatedNode ? [{ edge, direction: isOutgoing ? "outgoing" : "incoming", relatedNode }] : [];
  });
});

function graphNodeProjectName(node: GraphNode): string {
  if (!node.projectId) {
    return "—";
  }
  return graph.value?.projects.find((project) => project.id === node.projectId)?.name ?? "記錄中專案";
}

function selectGraphNode(node: GraphNode | null): void {
  selectedGraphNode.value = node;
}

function openGraphSession(node: GraphNode): void {
  selectedGraphNode.value = null;
  void useSessionDetail().openSessionDetail(node.sessionId, "無法載入 Graph 對應的 Session。");
}

function openGraphKnowledge(node: GraphNode): void {
  const knowledgeId = node.id.replace(/^knowledge:/, "");
  selectedGraphNode.value = null;
  const knowledge = useKnowledge();
  const item = knowledge.knowledgeItems.value.find((candidate) => candidate.id === knowledgeId);
  if (item) {
    knowledge.openKnowledgeEditor(item);
    return;
  }
  void router.push({ name: "knowledge" });
}

function openGraphProject(): void {
  selectedGraphNode.value = null;
  void router.push({ name: "projects" });
}

export function useGraph() {
  return {
    graph,
    graphProjectId,
    graphNodeFilter,
    graphPreviewLimit,
    graphLoadPreset,
    graphLoading,
    graphError,
    graphVisual,
    graphFilteredTotalNodes,
    graphCanLoadMore,
    graphNodeCounts,
    graphEdgeCounts,
    graphNodeDescription,
    loadGraph,
    loadMoreGraph,
    selectedGraphNode,
    selectedGraphNodeMetadata,
    selectedGraphNodeRelations,
    graphNodeProjectName,
    selectGraphNode,
    openGraphSession,
    openGraphKnowledge,
    openGraphProject
  };
}

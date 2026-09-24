import { computed, ref } from "vue";
import type {
  GraphEdge,
  GraphNode,
  GraphQueryResult,
  ProjectStatus,
  ReportVerificationStatus,
} from "@work-intelligence/core";
import { router } from "../router";
import { graphMetadataLabels, graphNodeKindLabels, graphNodeKindOrder, statusLabels } from "../utils/labels";
import { verificationStatus } from "../utils/status";
import { errorMessage, formatDate, graphNodeLabel, graphNodeLabelTail } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useKnowledge } from "./useKnowledge";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

export type GraphNodeFilter = GraphNode["kind"] | "all";
/** A laid-out node: `lane` is the kind column index, `y` the row centre in canvas pixels. */
export type GraphVisualNode = { node: GraphNode; lane: number; y: number };
export type GraphVisualEdge = { edge: GraphEdge; from: GraphVisualNode; to: GraphVisualNode };
type GraphNodeRelation = { edge: GraphEdge; direction: "incoming" | "outgoing"; relatedNode: GraphNode };

export const graphLoadPresetOptions = [
  { value: "180", label: "180 節點 / 360 關係", maxNodes: 180, maxEdges: 360 },
  { value: "300", label: "300 節點 / 720 關係", maxNodes: 300, maxEdges: 720 },
  { value: "500", label: "500 節點 / 1,000 關係", maxNodes: 500, maxEdges: 1_000 },
] as const;

const graphVisualBaseQuotas: Record<GraphNode["kind"], number> = {
  project: 8,
  session: 24,
  knowledge: 18,
  evidence: 18,
  file: 48,
};

const graph = ref<Extract<GraphQueryResult, { outcome: "graph" }> | null>(null);
const graphProjectId = ref("");
const graphNodeFilter = ref<GraphNodeFilter>("all");
const graphPreviewLimit = ref(120);
const graphLoadPreset = ref("180");
const graphSearch = ref("");
const graphLoading = ref(false);
const graphError = ref("");
const selectedGraphNode = ref<GraphNode | null>(null);
// Width of the docked node panel, so the graph can leave room for it.
const graphPanelWidth = ref(460);

async function loadGraph(cursor?: string): Promise<void> {
  graphLoading.value = true;
  graphError.value = "";
  const loadPreset =
    graphLoadPresetOptions.find((preset) => preset.value === graphLoadPreset.value) ?? graphLoadPresetOptions[0];
  await runKeyed(
    "graph",
    async (signal) => {
      const result = await useApi().client.getGraph(
        {
          projectId: graphProjectId.value || undefined,
          limit: 200,
          maxNodes: loadPreset.maxNodes,
          maxEdges: loadPreset.maxEdges,
          pageSize: loadPreset.maxNodes,
          cursor,
        },
        signal,
      );
      if (result.outcome !== "graph") {
        graph.value = null;
        graphError.value = result.reason;
        return;
      }
      const previous = graph.value;
      if (cursor && previous) {
        const nodes = [...previous.nodes, ...result.nodes].filter(
          (node, index, items) => items.findIndex((candidate) => candidate.id === node.id) === index,
        );
        const edges = [...previous.edges, ...result.edges].filter(
          (edge, index, items) => items.findIndex((candidate) => candidate.id === edge.id) === index,
        );
        graph.value = {
          ...result,
          nodes,
          edges,
          projects: previous.projects,
          sourceProjectIds: [...new Set([...previous.sourceProjectIds, ...result.sourceProjectIds])],
          sourceSessionIds: [...new Set([...previous.sourceSessionIds, ...result.sourceSessionIds])],
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
      },
    },
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

const graphAdjacency = computed(() => {
  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const neighbours = adjacency.get(from) ?? new Set<string>();
    neighbours.add(to);
    adjacency.set(from, neighbours);
  };
  for (const edge of graph.value?.edges ?? []) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  return adjacency;
});

const graphSearchTerm = computed(() => graphSearch.value.trim().toLowerCase());

function matchesGraphSearch(node: GraphNode, term: string): boolean {
  return node.label.toLowerCase().includes(term) || node.id.toLowerCase().includes(term);
}

/**
 * Picks which loaded nodes to draw. Sessions come first (newest first); the other kinds prefer
 * nodes attached to those Sessions, so fewer edges end up with a hidden endpoint.
 */
function selectVisibleNodes(filteredNodes: GraphNode[]): GraphNode[] {
  const term = graphSearchTerm.value;
  const adjacency = graphAdjacency.value;
  if (term) {
    // Search shows the matches plus their direct neighbours so each hit keeps its context.
    const matches = filteredNodes.filter((node) => matchesGraphSearch(node, term));
    const nodesById = new Map((graph.value?.nodes ?? []).map((node) => [node.id, node]));
    const selected = new Map(matches.map((node) => [node.id, node]));
    for (const match of matches) {
      for (const neighbourId of adjacency.get(match.id) ?? []) {
        const neighbour = nodesById.get(neighbourId);
        if (neighbour && !selected.has(neighbourId)) {
          selected.set(neighbourId, neighbour);
        }
      }
    }
    return [...selected.values()].slice(0, graphPreviewLimit.value);
  }
  if (graphNodeFilter.value !== "all") {
    return filteredNodes.slice(0, graphPreviewLimit.value);
  }

  const byKind = (kind: GraphNode["kind"]): GraphNode[] => filteredNodes.filter((node) => node.kind === kind);
  const sessions = byKind("session").slice(0, graphVisualQuotas.value.session);
  const sessionRank = new Map(sessions.map((node, index) => [node.id, index]));
  const firstSessionRank = (node: GraphNode): number =>
    Math.min(
      ...[...(adjacency.get(node.id) ?? [])].map((id) => sessionRank.get(id) ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
  const attachedFirst = (kind: GraphNode["kind"]): GraphNode[] =>
    byKind(kind)
      .map((node, index) => ({ node, index, rank: firstSessionRank(node) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .slice(0, graphVisualQuotas.value[kind])
      .map((item) => item.node);
  return graphNodeKindOrder.flatMap((kind) => (kind === "session" ? sessions : attachedFirst(kind)));
}

const graphLaneTop = 48;
const graphRowHeight = 58;

/**
 * Layered layout: Sessions sit on evenly spaced rows; knowledge, evidence and files sit next to the
 * mean row of the Sessions they belong to (pushed down only to avoid overlap), so most edges run
 * horizontally. Projects stay packed at the top of their lane.
 */
function layoutGraphNodes(visibleNodes: GraphNode[]): Map<string, GraphVisualNode> {
  const adjacency = graphAdjacency.value;
  const laneIndex = new Map<GraphNode["kind"], number>(graphNodeKindOrder.map((kind, index) => [kind, index]));
  const positions = new Map<string, GraphVisualNode>();
  const rowY = (index: number): number => graphLaneTop + index * graphRowHeight;

  const sessions = visibleNodes.filter((node) => node.kind === "session");
  sessions.forEach((node, index) =>
    positions.set(node.id, { node, lane: laneIndex.get("session") ?? 1, y: rowY(index) }),
  );
  const sessionY = (node: GraphNode): number[] =>
    [...(adjacency.get(node.id) ?? [])].flatMap((id) => {
      const position = positions.get(id);
      return position && position.node.kind === "session" ? [position.y] : [];
    });

  for (const kind of graphNodeKindOrder) {
    if (kind === "session") {
      continue;
    }
    const laneNodes = visibleNodes.filter((node) => node.kind === kind);
    const anchored = laneNodes.map((node, index) => {
      const ys = sessionY(node);
      const ideal =
        kind === "project" || ys.length === 0
          ? Number.POSITIVE_INFINITY
          : ys.reduce((total, y) => total + y, 0) / ys.length;
      const order = kind === "project" && ys.length ? Math.min(...ys) : index;
      return { node, ideal, order };
    });
    anchored.sort((left, right) => left.ideal - right.ideal || left.order - right.order);
    let previousY = graphLaneTop - graphRowHeight;
    for (const item of anchored) {
      const y = Number.isFinite(item.ideal)
        ? Math.max(item.ideal, previousY + graphRowHeight)
        : previousY + graphRowHeight;
      positions.set(item.node.id, { node: item.node, lane: laneIndex.get(kind) ?? 0, y });
      previousY = y;
    }
  }
  return positions;
}

const graphVisual = computed(() => {
  if (!graph.value) {
    return {
      height: 560,
      nodes: [] as GraphVisualNode[],
      edges: [] as GraphVisualEdge[],
      hiddenNodes: 0,
      hiddenEdges: 0,
      searchMatches: 0,
    };
  }

  const filteredNodes =
    graphNodeFilter.value === "all"
      ? graph.value.nodes
      : graph.value.nodes.filter((node) => node.kind === graphNodeFilter.value);
  const visibleNodes = selectVisibleNodes(filteredNodes);
  const hiddenNodeIds = new Set(filteredNodes.map((node) => node.id));
  visibleNodes.forEach((node) => hiddenNodeIds.delete(node.id));
  const positions = layoutGraphNodes(visibleNodes);

  const graphEdges = graph.value.edges.reduce<GraphVisualEdge[]>((items, edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from && to) {
      items.push({ edge, from, to });
    }
    return items;
  }, []);
  const nodes = visibleNodes
    .map((node) => positions.get(node.id))
    .filter((node): node is GraphVisualNode => Boolean(node));
  const bottom = Math.max(...nodes.map((item) => item.y), graphLaneTop);
  const term = graphSearchTerm.value;
  return {
    height: Math.max(560, bottom + graphRowHeight),
    nodes,
    edges: graphEdges,
    hiddenNodes: term ? 0 : hiddenNodeIds.size,
    hiddenEdges: graph.value.edges.length - graphEdges.length,
    searchMatches: term ? filteredNodes.filter((node) => matchesGraphSearch(node, term)).length : 0,
  };
});

/** Ids of the matching nodes when a search is active (the rest of the view is their context). */
const graphSearchMatchIds = computed(() => {
  const term = graphSearchTerm.value;
  if (!term) {
    return new Set<string>();
  }
  return new Set(
    graphVisual.value.nodes.filter((item) => matchesGraphSearch(item.node, term)).map((item) => item.node.id),
  );
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

function splitFilePath(path: string): { name: string; folder: string } {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0
    ? { name: normalized, folder: "" }
    : { name: normalized.slice(index + 1), folder: normalized.slice(0, index) };
}

/** Canvas title: files show their file name (the folder goes on the second line). */
function graphNodeDisplayLabel(node: GraphNode, maxDisplayUnits = 25): string {
  return graphNodeLabel(node.kind === "file" ? splitFilePath(node.label).name : node.label, maxDisplayUnits);
}

function graphNodeDescription(node: GraphNode, maxDisplayUnits = 30): string {
  if (node.kind === "session") {
    // Missing verification is historical not_supplied (未回報), never not_run.
    const status = String(node.metadata.verification ?? "not_supplied");
    const label = status in verificationStatus ? verificationStatus[status as ReportVerificationStatus].label : status;
    return `${label} · ${String(node.metadata.changedFilesCount ?? 0)} 個檔案`;
  }
  if (node.kind === "knowledge") {
    return String(node.metadata.kind ?? "knowledge");
  }
  if (node.kind === "evidence") {
    return String(node.metadata.kind ?? "evidence");
  }
  if (node.kind === "file") {
    return graphNodeLabelTail(splitFilePath(node.label).folder || "（專案根目錄）", maxDisplayUnits);
  }
  const status = String(node.metadata.status ?? "tracked");
  return status in statusLabels ? statusLabels[status as ProjectStatus] : status;
}

function formatGraphMetadataValue(key: string, value: string | number | boolean): string {
  if (key === "status" && typeof value === "string" && value in statusLabels) {
    return statusLabels[value as ProjectStatus];
  }
  if (key === "verification" && typeof value === "string" && value in verificationStatus) {
    return verificationStatus[value as ReportVerificationStatus].label;
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
    value: formatGraphMetadataValue(key, value),
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
    graphSearch,
    graphSearchMatchIds,
    graphLoading,
    graphError,
    graphVisual,
    graphFilteredTotalNodes,
    graphCanLoadMore,
    graphNodeCounts,
    graphNodeDescription,
    graphNodeDisplayLabel,
    loadGraph,
    loadMoreGraph,
    selectedGraphNode,
    graphPanelWidth,
    selectedGraphNodeMetadata,
    selectedGraphNodeRelations,
    graphNodeProjectName,
    selectGraphNode,
    openGraphSession,
    openGraphKnowledge,
    openGraphProject,
  };
}

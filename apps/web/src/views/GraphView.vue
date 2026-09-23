<script setup lang="ts">
import { computed } from "vue";
import type { GraphEdge, GraphNode, GraphQueryResult, ProjectRecord } from "@work-intelligence/core";
import GraphCanvas from "../components/GraphCanvas.vue";

type GraphResult = Extract<GraphQueryResult, { outcome: "graph" }>;
type GraphNodeFilter = GraphNode["kind"] | "all";

type GraphVisualNode = {
  node: GraphNode;
  x: number;
  y: number;
};

type GraphVisualEdge = {
  edge: GraphEdge;
  from: GraphVisualNode;
  to: GraphVisualNode;
};

type GraphVisual = {
  width: number;
  height: number;
  nodes: readonly GraphVisualNode[];
  edges: readonly GraphVisualEdge[];
  hiddenNodes: number;
  hiddenEdges: number;
};

type GraphLoadPreset = {
  value: string;
  label: string;
  maxNodes: number;
  maxEdges: number;
};

type GraphNodeCount = {
  kind: GraphNode["kind"];
  label: string;
  count: number;
};

type GraphEdgeCount = {
  kind: GraphEdge["kind"];
  label: string;
  count: number;
};

const props = defineProps<{
  trackedProjects: readonly ProjectRecord[];
  graph: GraphResult | null;
  graphProjectId: string;
  graphNodeFilter: GraphNodeFilter;
  graphPreviewLimit: number;
  graphLoadPreset: string;
  graphLoadPresetOptions: readonly GraphLoadPreset[];
  graphLoading: boolean;
  graphError: string;
  graphNodeKindOrder: readonly GraphNode["kind"][];
  graphNodeKindLabels: Readonly<Record<GraphNode["kind"], string>>;
  graphEdgeKindLabels: Readonly<Record<GraphEdge["kind"], string>>;
  graphVisual: GraphVisual;
  graphFilteredTotalNodes: number;
  graphNodeCounts: readonly GraphNodeCount[];
  graphEdgeCounts: readonly GraphEdgeCount[];
  graphCanLoadMore: boolean;
  graphNodeFilterLabel: string;
  graphNodeLabel: (value: string) => string;
  graphNodeDescription: (node: GraphNode) => string;
}>();

const emit = defineEmits<{
  "update:graphProjectId": [value: string];
  "update:graphNodeFilter": [value: GraphNodeFilter];
  "update:graphPreviewLimit": [value: number];
  "update:graphLoadPreset": [value: string];
  load: [];
  loadMore: [];
  selectNode: [node: GraphNode];
}>();

const graphProjectIdModel = computed({
  get: () => props.graphProjectId,
  set: (value: string) => emit("update:graphProjectId", value)
});

const graphNodeFilterModel = computed({
  get: () => props.graphNodeFilter,
  set: (value: GraphNodeFilter) => emit("update:graphNodeFilter", value)
});

const graphPreviewLimitModel = computed({
  get: () => props.graphPreviewLimit,
  set: (value: number) => emit("update:graphPreviewLimit", value)
});

const graphLoadPresetModel = computed({
  get: () => props.graphLoadPreset,
  set: (value: string) => emit("update:graphLoadPreset", value)
});
</script>

<template>
  <section class="page-section graph-page">
    <div class="section-intro graph-intro">
      <div>
        <div class="eyebrow">DETERMINISTIC WORK GRAPH</div>
        <h2>把 Session、檔案、知識與證據連起來。</h2>
        <p>圖譜只使用已保存的結構化資料；不讀取 source、handoff 或 Git，也不替資料推測語意關係。</p>
      </div>
      <div class="tracked-summary"><strong>{{ graph?.totalNodes ?? 0 }}</strong><span>個圖譜節點</span></div>
    </div>

    <form class="graph-tools" @submit.prevent="emit('load')">
      <label class="filter-field">
        <span>專案範圍</span>
        <select v-model="graphProjectIdModel" aria-label="選擇 Graph 專案範圍">
          <option value="">所有記錄中專案</option>
          <option v-for="project in trackedProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span>節點類型</span>
        <select v-model="graphNodeFilterModel" aria-label="選擇 Graph 節點類型">
          <option value="all">全部類型</option>
          <option v-for="kind in graphNodeKindOrder" :key="kind" :value="kind">{{ graphNodeKindLabels[kind] }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span>畫面預覽量</span>
        <select v-model.number="graphPreviewLimitModel" aria-label="選擇 Graph 畫面預覽量">
          <option :value="60">精簡（最多 60）</option>
          <option :value="120">標準（最多 120）</option>
          <option :value="180">展開（最多 180）</option>
        </select>
      </label>
      <label class="filter-field">
        <span>資料載入上限</span>
        <select v-model="graphLoadPresetModel" aria-label="選擇 Graph 資料載入上限">
          <option v-for="preset in graphLoadPresetOptions" :key="preset.value" :value="preset.value">{{ preset.label }}</option>
        </select>
      </label>
      <span class="graph-policy-note">只顯示「記錄中」專案；類型與預覽量可立即切換</span>
      <button class="filter-button" type="submit" :disabled="graphLoading">{{ graphLoading ? '整理中…' : '更新圖譜' }}</button>
      <button v-if="graphCanLoadMore" class="text-button graph-load-more-button" type="button" :disabled="graphLoading" @click="emit('loadMore')">載入更多資料</button>
    </form>

    <div v-if="graphError" class="alert error-alert" role="alert">{{ graphError }}</div>
    <section v-if="graphLoading" class="loading-state graph-loading">
      <div class="spinner"></div>
      <p>正在整理本機工作圖譜…</p>
    </section>
    <template v-else-if="graph">
      <div class="graph-stat-grid">
        <article class="graph-stat-card graph-stat-total"><span>節點總數</span><strong>{{ graph.totalNodes }}</strong><small>完整範圍總數</small></article>
        <article class="graph-stat-card graph-stat-total"><span>關係總數</span><strong>{{ graph.totalEdges }}</strong><small>完整範圍總數</small></article>
        <article v-for="item in graphNodeCounts" :key="item.kind" class="graph-stat-card"><span>{{ item.label }}</span><strong>{{ item.count }}</strong><small>圖譜節點</small></article>
      </div>

      <section class="panel graph-visual-panel">
        <div class="panel-heading">
          <div>
            <div class="eyebrow">RELATIONSHIP MAP</div>
            <h3>工作關係圖</h3>
          </div>
          <span class="report-count" data-testid="graph-visible-count">顯示 {{ graphVisual.nodes.length }} / {{ graphFilteredTotalNodes }} 節點</span>
        </div>
        <div v-if="graph.nodes.length === 0" class="empty-state graph-empty"><div class="empty-icon">◎</div><strong>目前沒有可視化資料</strong><p>tracked project 完成 Session 後，這裡會出現工作關係。</p></div>
        <GraphCanvas
          v-else
          :nodes="graphVisual.nodes"
          :edges="graphVisual.edges"
          :width="graphVisual.width"
          :height="graphVisual.height"
          :node-kind-order="graphNodeKindOrder"
          :node-kind-labels="graphNodeKindLabels"
          :edge-kind-labels="graphEdgeKindLabels"
          :node-label="graphNodeLabel"
          :node-description="graphNodeDescription"
          @select="emit('selectNode', $event)"
        />
        <p class="graph-panel-note">目前顯示 {{ graphVisual.nodes.length }} / {{ graphFilteredTotalNodes }} 個{{ graphNodeFilterLabel }}、{{ graphVisual.edges.length }} / {{ graph.totalEdges }} 條關係。{{ graph.truncation.nodesTruncated || graph.truncation.edgesTruncated ? '資料已依載入上限受控；可提高「資料載入上限」或按「載入更多資料」。' : '目前範圍的資料已完整載入。' }}<span v-if="graphVisual.hiddenNodes"> 畫面另省略 {{ graphVisual.hiddenNodes }} 個節點。</span><span v-if="graphVisual.hiddenEdges"> 另有 {{ graphVisual.hiddenEdges }} 條關係因端點被省略而未繪出。</span></p>
      </section>

      <div class="content-grid graph-secondary-grid">
        <section class="panel graph-breakdown-panel">
          <div class="panel-heading">
            <div>
              <div class="eyebrow">NODE BREAKDOWN</div>
              <h3>節點分布</h3>
            </div>
            <span class="report-count">{{ graph.projects.length }} 個專案</span>
          </div>
          <div class="graph-breakdown-list">
            <div v-for="item in graphNodeCounts" :key="item.kind" class="graph-breakdown-row">
              <span :class="['graph-kind-dot', `graph-kind-${item.kind}`]"></span>
              <strong>{{ item.label }}</strong>
              <span>{{ item.count }} 個節點</span>
            </div>
          </div>
          <p class="graph-panel-note">來源 Projects：{{ graph.sourceProjectIds.length }} · 來源 Sessions：{{ graph.sourceSessionIds.length }}</p>
        </section>

        <section class="panel graph-breakdown-panel">
          <div class="panel-heading">
            <div>
              <div class="eyebrow">EDGE LEGEND</div>
              <h3>關係類型</h3>
            </div>
            <span class="report-count">{{ graph.edges.length }} 條關係</span>
          </div>
          <div class="graph-breakdown-list">
            <div v-for="item in graphEdgeCounts" :key="item.kind" class="graph-breakdown-row">
              <span class="graph-edge-mark">→</span>
              <strong>{{ item.label }}</strong>
              <span>{{ item.count }} 條關係</span>
            </div>
          </div>
          <p class="graph-panel-note">目前關係皆可回溯到 Project Registry、Session、Knowledge、Evidence 或 changed-files metadata。</p>
        </section>
      </div>
    </template>
    <div v-else class="empty-state large-empty graph-empty-state"><div class="empty-icon">◎</div><strong>尚未載入工作圖譜</strong><p>切換到 Graph 後，系統會從已授權的工作紀錄建立結構化視圖。</p></div>
  </section>
</template>

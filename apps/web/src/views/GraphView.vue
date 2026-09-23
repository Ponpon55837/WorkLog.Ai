<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { FolderGit2, Search, SearchX, Share2 } from "lucide-vue-next";
import type { GraphNode } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import GraphNodePanel from "../components/domain/GraphNodePanel.vue";
import GraphCanvas from "../components/GraphCanvas.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { graphLoadPresetOptions, useGraph, type GraphNodeFilter } from "../composables/useGraph";
import { useProjects } from "../composables/useProjects";
import { stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { graphEdgeKindLabels, graphNodeKindLabels, graphNodeKindOrder } from "../utils/labels";

const { trackedProjects } = useProjects();
const {
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
  selectGraphNode
} = useGraph();

const load = (): Promise<void> => loadGraph();
useRouteQuery("project", graphProjectId, stringQuery());
useRouteQuery("q", graphSearch, stringQuery());
useViewLoader(load);
watch([graphProjectId, graphLoadPreset], () => void load());
onBeforeUnmount(() => selectGraphNode(null));

const projectOptions = computed(() => [{ value: "", label: "所有記錄中專案" }, ...trackedProjects.value.map((project) => ({ value: project.id, label: project.name }))]);
const kindOptions: { value: GraphNodeFilter; label: string }[] = [
  { value: "all", label: "全部類型" },
  ...graphNodeKindOrder.map((kind) => ({ value: kind, label: graphNodeKindLabels[kind] }))
];
const previewOptions = [
  { value: 60, label: "精簡（最多 60）" },
  { value: 120, label: "標準（最多 120）" },
  { value: 180, label: "展開（最多 180）" }
];
const presetOptions = graphLoadPresetOptions.map((preset) => ({ value: preset.value as string, label: preset.label }));

const truncationNote = computed(() => {
  const current = graph.value;
  if (!current) {
    return "";
  }
  const parts = [
    current.truncation.nodesTruncated || current.truncation.edgesTruncated ? "資料已依載入上限受控，可提高上限或載入更多。" : "目前範圍的資料已完整載入。"
  ];
  if (graphVisual.value.hiddenNodes) {
    parts.push(`畫面另省略 ${graphVisual.value.hiddenNodes} 個節點。`);
  }
  if (graphVisual.value.hiddenEdges) {
    parts.push(`${graphVisual.value.hiddenEdges} 條關係因端點被省略而未繪出。`);
  }
  return parts.join(" ");
});

const graphStyle = computed(() => (selectedGraphNode.value ? { "--graph-panel-width": `${graphPanelWidth.value}px` } : {}));

const countLabel = computed(() =>
  graphSearch.value.trim()
    ? `符合 ${graphVisual.value.searchMatches} 個節點 · 顯示 ${graphVisual.value.nodes.length} / ${graphFilteredTotalNodes.value} 節點`
    : `顯示 ${graphVisual.value.nodes.length} / ${graphFilteredTotalNodes.value} 節點`
);

function onSelect(node: GraphNode): void {
  selectGraphNode(node);
}

/** Enter in the search box jumps to the first hit instead of submitting the toolbar form. */
function selectFirstMatch(): void {
  const first = graphVisual.value.nodes.find((item) => graphSearchMatchIds.value.has(item.node.id));
  if (first) {
    selectGraphNode(first.node);
  }
}
</script>

<template>
  <PageHeader description="只使用已保存的結構化資料；不讀取 source、handoff 或 Git，也不替資料推測語意關係。" />

  <UiFlash v-if="graphError" tone="danger">
    {{ graphError }}
    <template #actions><UiButton size="sm" @click="load">重試</UiButton></template>
  </UiFlash>

  <UiBox :class="['graph', { 'graph--with-panel': selectedGraphNode }]" :style="graphStyle">
    <template #header>
      <form class="graph__toolbar" @submit.prevent="load">
        <UiTextInput v-model="graphSearch" type="search" :icon="Search" size="sm" placeholder="搜尋節點名稱…" label="搜尋 Graph 節點" class="graph__search" @keydown.enter.prevent="selectFirstMatch" />
        <UiSelect v-model="graphProjectId" :options="projectOptions" :icon="FolderGit2" size="sm" label="選擇 Graph 專案範圍" />
        <UiSelect v-model="graphNodeFilter" :options="kindOptions" size="sm" label="選擇 Graph 節點類型" />
        <UiSelect v-model="graphPreviewLimit" :options="previewOptions" size="sm" label="選擇 Graph 畫面預覽量" />
        <UiSelect v-model="graphLoadPreset" :options="presetOptions" size="sm" label="選擇 Graph 資料載入上限" />
        <UiButton type="submit" size="sm" :loading="graphLoading">更新圖譜</UiButton>
        <UiButton v-if="graphCanLoadMore" size="sm" variant="invisible" :disabled="graphLoading" @click="loadMoreGraph">載入更多資料</UiButton>
      </form>
      <span v-if="graph" class="graph__count" data-testid="graph-visible-count">{{ countLabel }}</span>
    </template>

    <div v-if="graph" class="graph__legend" aria-label="節點分布">
      <span><strong>{{ graph.totalNodes }}</strong> 節點</span>
      <span><strong>{{ graph.totalEdges }}</strong> 關係</span>
      <span v-for="item in graphNodeCounts" :key="item.kind" :class="`graph__legend-item graph__legend-item--${item.kind}`"><i aria-hidden="true"></i>{{ item.label }} {{ item.count }}</span>
    </div>

    <UiSkeleton v-if="graphLoading && !graph" variant="card" :count="3" />
    <UiEmptyState v-else-if="!graph || graph.nodes.length === 0" :icon="Share2" title="目前沒有可視化資料" description="記錄中的專案完成 Session 後，這裡會出現工作關係。" />
    <UiEmptyState v-else-if="graphSearch.trim() && graphVisual.nodes.length === 0" :icon="SearchX" title="沒有符合的節點" description="搜尋只比對目前已載入的節點；可以換個關鍵字，或提高資料載入上限。">
      <template #action><UiButton size="sm" @click="graphSearch = ''">清除搜尋</UiButton></template>
    </UiEmptyState>
    <GraphCanvas
      v-else
      :nodes="graphVisual.nodes"
      :edges="graphVisual.edges"
      :height="graphVisual.height"
      :node-kind-order="graphNodeKindOrder"
      :node-kind-labels="graphNodeKindLabels"
      :edge-kind-labels="graphEdgeKindLabels"
      :node-label="graphNodeDisplayLabel"
      :node-description="graphNodeDescription"
      :selected-id="selectedGraphNode?.id"
      :match-ids="graphSearchMatchIds"
      @select="onSelect"
      @clear="selectGraphNode(null)"
    />

    <template v-if="graph" #footer>
      <span>{{ truncationNote }}</span>
      <span>來源 Projects {{ graph.sourceProjectIds.length }} · Sessions {{ graph.sourceSessionIds.length }}</span>
    </template>
  </UiBox>

  <GraphNodePanel />
</template>

<style scoped>
.graph--with-panel {
  margin-right: var(--graph-panel-width, 460px);
}

.graph__search {
  width: 200px;
}

.graph__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.graph__count {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.graph__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.graph__legend strong {
  color: var(--fg);
}

.graph__legend-item i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  border: 1px solid var(--border);
  border-radius: 2px;
  vertical-align: -1px;
}

.graph__legend-item--project i { border-color: var(--success-border); background: var(--success-soft); }
.graph__legend-item--session i { border-color: var(--accent-border); background: var(--accent-soft); }
.graph__legend-item--knowledge i { border-color: var(--done-border); background: var(--done-soft); }
.graph__legend-item--evidence i { border-color: var(--attention-border); background: var(--attention-soft); }

@media (max-width: 959px) {
  .graph--with-panel {
    margin-right: 0;
  }
}
</style>

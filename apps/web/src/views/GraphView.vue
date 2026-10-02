<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import { CalendarRange, Flame, FolderGit2, Search, SearchX, Share2 } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import type { GraphNode } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import GraphHotspotsBox from "../components/domain/GraphHotspotsBox.vue";
import GraphTimelineBox from "../components/domain/GraphTimelineBox.vue";
import GraphNodePanel from "../components/domain/GraphNodePanel.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import GraphCanvas from "../components/GraphCanvas.vue";
import { useGraph, type GraphNodeFilter } from "../composables/useGraph";
import { stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { router } from "../router";
import { graphLoadPresetOptions, useGraphStore } from "../stores/graph";
import { useProjectsStore } from "../stores/projects";
import { graphEdgeKindLabels, graphNodeKindLabels, graphNodeKindOrder } from "../utils/labels";
import { t } from "../i18n";

type GraphTab = "graph" | "timeline" | "hotspots";
const graphTabs: readonly GraphTab[] = ["graph", "timeline", "hotspots"];

const route = useRoute();
const projectsStore = useProjectsStore();
const { trackedProjects } = storeToRefs(projectsStore);
const graphStore = useGraphStore();
const {
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
  graphPathEdgeIds,
} = storeToRefs(graphStore);
const {
  graphSearchMatchIds,
  graphVisual,
  graphFilteredTotalNodes,
  graphNodeCounts,
  graphNodeDescription,
  graphNodeDisplayLabel,
} = useGraph();

const load = (): Promise<void> => graphStore.loadGraph();
useRouteQuery("project", graphProjectId, stringQuery());
useRouteQuery("q", graphSearch, stringQuery());

const tab = computed<GraphTab>({
  get: () => {
    const value = String(route.params.tab ?? "");
    return (graphTabs as readonly string[]).includes(value) ? (value as GraphTab) : "graph";
  },
  set: (value) =>
    void router.replace({ name: "graph", params: { tab: value === "graph" ? undefined : value }, query: route.query }),
});
const tabItems = [
  { value: "graph" as const, label: t("graph.graph"), icon: Share2 },
  { value: "timeline" as const, label: t("graph.timeline"), icon: CalendarRange },
  { value: "hotspots" as const, label: t("common.hotspots"), icon: Flame },
];
const projectOptions = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...trackedProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const kindOptions: { value: GraphNodeFilter; label: string }[] = [
  { value: "all", label: t("graph.allKinds") },
  ...graphNodeKindOrder.map((kind) => ({ value: kind, label: graphNodeKindLabels[kind] })),
];
const previewOptions = [
  { value: 60, label: t("graph.compactUpTo60") },
  { value: 120, label: t("graph.standardUpTo120") },
  { value: 180, label: t("graph.expandUpTo180") },
];
const presetOptions = graphLoadPresetOptions.map((preset) => ({
  value: preset.value as string,
  label: t(preset.label),
}));

const truncationNote = computed(() => {
  const current = graph.value;
  if (!current) {
    return "";
  }
  const parts = [
    current.truncation.nodesTruncated || current.truncation.edgesTruncated
      ? t("graph.dataIsCappedByThe")
      : t("graph.allDataInTheCurrent"),
  ];
  if (graphVisual.value.hiddenNodes) {
    parts.push(t("graph.moreNodesAreNotShown", { hiddenNodes: graphVisual.value.hiddenNodes }));
  }
  if (graphVisual.value.hiddenEdges) {
    parts.push(t("graph.edgesAreNotDrawnBecause", { hiddenEdges: graphVisual.value.hiddenEdges }));
  }
  return parts.join(" ");
});

const countLabel = computed(() =>
  graphSearch.value.trim()
    ? t("graph.matchingNodesShowingNodes", {
        searchMatches: graphVisual.value.searchMatches,
        length: graphVisual.value.nodes.length,
        graphFilteredTotalNodes: graphFilteredTotalNodes.value,
      })
    : t("graph.showingNodes", {
        length: graphVisual.value.nodes.length,
        graphFilteredTotalNodes: graphFilteredTotalNodes.value,
      }),
);

function onSelect(node: GraphNode): void {
  graphStore.selectGraphNode(node);
}

/** Enter in the search box jumps to the first hit instead of submitting the toolbar form. */
function selectFirstMatch(): void {
  const first = graphVisual.value.nodes.find((item) => graphSearchMatchIds.value.has(item.node.id));
  if (first) {
    graphStore.selectGraphNode(first.node);
  }
}

// Only the open tab loads its data.
watch(tab, (value) => graphStore.setGraphActive(value === "graph"), { immediate: true });

onBeforeUnmount(() => {
  graphStore.setGraphActive(false);
  graphStore.selectGraphNode(null);
});
</script>

<template>
  <PageHeader :description="t('graph.usesOnlySavedStructuredData')" />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabItems" :label="t('graph.workGraphTabs')" id-prefix="graph" />
  </PageToolbar>

  <section v-if="tab === 'timeline'" id="graph-panel-timeline" role="tabpanel" aria-labelledby="graph-tab-timeline">
    <GraphTimelineBox v-model:project-id="graphProjectId" :projects="trackedProjects" />
  </section>
  <section
    v-else-if="tab === 'hotspots'"
    id="graph-panel-hotspots"
    role="tabpanel"
    aria-labelledby="graph-tab-hotspots"
  >
    <GraphHotspotsBox v-model:project-id="graphProjectId" :projects="trackedProjects" />
  </section>

  <section v-else id="graph-panel-graph" role="tabpanel" aria-labelledby="graph-tab-graph">
    <UiFlash v-if="graphError" tone="danger">
      {{ graphError }}
      <template #actions
        ><UiButton size="sm" @click="load">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>

    <UiBox class="graph">
      <template #header>
        <form class="graph__toolbar" @submit.prevent="load">
          <UiTextInput
            v-model="graphSearch"
            type="search"
            :icon="Search"
            size="sm"
            :placeholder="t('graph.searchNodeNames')"
            :label="t('graph.searchGraphNodes')"
            class="graph__search"
            @keydown.enter.prevent="selectFirstMatch"
          />
          <UiSelect
            v-model="graphProjectId"
            :options="projectOptions"
            :icon="FolderGit2"
            size="sm"
            :label="t('graph.chooseGraphProjectScope')"
          />
          <UiSelect
            v-model="graphNodeFilter"
            :options="kindOptions"
            size="sm"
            :label="t('graph.chooseGraphNodeKind')"
          />
          <UiSelect
            v-model="graphPreviewLimit"
            :options="previewOptions"
            size="sm"
            :label="t('graph.chooseGraphPreviewSize')"
          />
          <UiSelect
            v-model="graphLoadPreset"
            :options="presetOptions"
            size="sm"
            :label="t('graph.chooseGraphLoadLimit')"
          />
          <label class="graph__derived">
            <input v-model="graphShowDerived" type="checkbox" data-testid="graph-show-derived" />
            {{ t("graph.showDerivedRelationships") }}
          </label>
          <UiButton type="submit" size="sm" :loading="graphLoading">{{ t("graph.updateGraph") }}</UiButton>
          <UiButton
            v-if="graphCanLoadMore"
            size="sm"
            variant="invisible"
            :disabled="graphLoading"
            @click="graphStore.loadMoreGraph"
            >{{ t("graph.loadMoreData") }}</UiButton
          >
        </form>
        <span v-if="graph" class="graph__count" data-testid="graph-visible-count">{{ countLabel }}</span>
      </template>

      <div v-if="graph" class="graph__legend" :aria-label="t('graph.nodeDistribution')">
        <span
          ><strong>{{ graph.totalNodes }}</strong> {{ t("graph.nodes") }}</span
        >
        <span
          ><strong>{{ graph.totalEdges }}</strong> {{ t("common.relationships") }}</span
        >
        <span
          v-for="item in graphNodeCounts"
          :key="item.kind"
          :class="`graph__legend-item graph__legend-item--${item.kind}`"
          ><i aria-hidden="true"></i>{{ item.label }} {{ item.count }}</span
        >
        <span class="graph__legend-line"
          ><svg aria-hidden="true" width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" /></svg
          >{{ t("graph.recordedRelationships") }}</span
        >
        <span class="graph__legend-line graph__legend-line--derived"
          ><svg aria-hidden="true" width="24" height="6"><line x1="0" y1="3" x2="24" y2="3" /></svg
          >{{ t("graph.derivedRelationshipsChangedTogetherHidden") }}</span
        >
      </div>

      <UiSkeleton v-if="graphLoading && !graph" variant="card" :count="3" :label="t('graph.loadingTheWorkGraph')" />
      <UiEmptyState
        v-else-if="!graph || graph.nodes.length === 0"
        :icon="Share2"
        :title="t('graph.nothingToVisualizeYet')"
        :description="t('graph.workRelationshipsAppearHereOnce')"
      />
      <UiEmptyState
        v-else-if="graphSearch.trim() && graphVisual.nodes.length === 0"
        :icon="SearchX"
        :title="t('graph.noMatchingNodes')"
        :description="t('graph.searchOnlyMatchesNodesAlready')"
      >
        <template #action
          ><UiButton size="sm" @click="graphSearch = ''">{{ t("graph.clearSearch") }}</UiButton></template
        >
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
        :overlay-width="selectedGraphNode ? graphPanelWidth : 0"
        :path-edge-ids="graphPathEdgeIds"
        @select="onSelect"
        @clear="graphStore.selectGraphNode(null)"
      />

      <template v-if="graph" #footer>
        <span>{{ truncationNote }}</span>
        <span>{{
          t("graph.sourceProjectsSessions", {
            length: graph.sourceProjectIds.length,
            length2: graph.sourceSessionIds.length,
          })
        }}</span>
      </template>
    </UiBox>
  </section>
  <GraphNodePanel />
</template>

<style scoped>
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

.graph__derived {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.graph__legend-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.graph__legend-line line {
  stroke: var(--fg-muted);
  stroke-width: 1.6;
}

.graph__legend-line--derived line {
  stroke-dasharray: 5 4;
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

.graph__legend-item--project i {
  border-color: var(--success-border);
  background: var(--success-soft);
}
.graph__legend-item--session i {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}
.graph__legend-item--knowledge i {
  border-color: var(--done-border);
  background: var(--done-soft);
}
.graph__legend-item--evidence i {
  border-color: var(--attention-border);
  background: var(--attention-soft);
}
</style>

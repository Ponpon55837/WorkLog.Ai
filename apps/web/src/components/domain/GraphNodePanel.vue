<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, BookOpen, FolderGit2, ListChecks, Route, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import type { GraphEdge, GraphNode } from "@work-intelligence/core";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import VirtualList from "../VirtualList.vue";
import { useGraph } from "../../composables/useGraph";
import { useGraphStore } from "../../stores/graph";
import { graphEdgeKindLabels, graphNodeKindLabels } from "../../utils/labels";
import { t } from "../../i18n";

/** Docked, non-modal node detail: the graph stays interactive while the panel is open. */
const graphStore = useGraphStore();
const {
  graph,
  selectedGraphNode: node,
  graphPanelWidth,
  graphPath,
  graphPathLoading,
  graphPathError,
} = storeToRefs(graphStore);
const {
  selectedGraphNodeMetadata: metadata,
  selectedGraphNodeRelations: relations,
  graphNodeProjectName,
  graphNodeDisplayLabel,
  graphNodeDescription,
  openGraphSession,
  openGraphKnowledge,
  openGraphProject,
} = useGraph();
const { selectGraphNode } = graphStore;

const pathTarget = ref("");

const targetOptions = computed(() => [
  { value: "", label: t("graph.chooseANodeToCompare") },
  ...(graph.value?.nodes ?? [])
    .filter((item) => item.id !== node.value?.id)
    .map((item) => ({
      value: item.id,
      label: t("graph.nodeKindAndLabel", {
        value: graphNodeKindLabels[item.kind],
        value2: graphNodeDisplayLabel(item, 40),
      }),
    }))
    .sort((left, right) => left.label.localeCompare(right.label)),
]);

/** Relation subtitle; avoids "變更檔案 · 變更檔案" and shows the folder for files. */
function relationDetail(edge: GraphEdge, related: GraphNode): string {
  if (edge.reason) {
    return `${graphEdgeKindLabels[edge.kind]} · ${edge.reason}`;
  }
  const edgeLabel = graphEdgeKindLabels[edge.kind];
  const kindLabel = graphNodeKindLabels[related.kind];
  const context = related.kind === "file" ? graphNodeDescription(related, 48) : kindLabel;
  return edgeLabel === kindLabel && related.kind !== "file" ? edgeLabel : `${edgeLabel} · ${context}`;
}

function explainPath(): void {
  if (node.value && pathTarget.value) {
    graphStore.findGraphPath(node.value.id, pathTarget.value);
  }
}

// A new node starts without a path; the previous one no longer applies.
watch(
  () => node.value?.id,
  () => {
    pathTarget.value = "";
    graphStore.clearGraphPath();
  },
);
</script>

<template>
  <UiSidePanel
    :open="Boolean(node)"
    :modal="false"
    :width="460"
    storage-key="graph-node"
    :label="t('graph.graphNodeDetails')"
    @close="selectGraphNode(null)"
    @resize="graphPanelWidth = $event"
  >
    <template v-if="node" #header>
      <div class="node-panel__top">
        <UiLabel tone="accent">{{ graphNodeKindLabels[node.kind] }}</UiLabel>
        <UiIconButton :icon="X" :label="t('graph.closeGraphNodeDetails')" @click="selectGraphNode(null)" />
      </div>
      <h2 class="node-panel__title">{{ node.label }}</h2>
      <code class="node-panel__id">{{ node.id }}</code>
    </template>

    <div v-if="node" class="node-panel">
      <dl class="node-panel__meta">
        <dt>{{ t("graph.sourceProject") }}</dt>
        <dd>{{ graphNodeProjectName(node) }}</dd>
        <dt>{{ t("graph.relationships") }}</dt>
        <dd>{{ relations.length }}</dd>
        <template v-for="item in metadata" :key="item.key">
          <dt>{{ item.label }}</dt>
          <dd class="mono">{{ item.value }}</dd>
        </template>
      </dl>

      <div class="node-panel__actions">
        <UiButton v-if="node.sessionId" size="sm" :icon="ListChecks" @click="openGraphSession(node)">{{
          t("graph.viewSessionDetails")
        }}</UiButton>
        <UiButton v-if="node.kind === 'knowledge'" size="sm" :icon="BookOpen" @click="openGraphKnowledge(node)">{{
          t("graph.maintainKnowledge")
        }}</UiButton>
        <UiButton v-if="node.kind === 'project'" size="sm" :icon="FolderGit2" @click="openGraphProject">{{
          t("graph.manageProjects")
        }}</UiButton>
      </div>

      <section class="node-panel__path" data-testid="graph-path">
        <h3 class="node-panel__heading">{{ t("graph.findConnectionsToOtherNodes") }}</h3>
        <form class="node-panel__path-form" @submit.prevent="explainPath">
          <UiSelect v-model="pathTarget" :options="targetOptions" size="sm" :label="t('graph.chooseANodeToFind')" />
          <UiButton type="submit" size="sm" :icon="Route" :disabled="!pathTarget" :loading="graphPathLoading">{{
            t("graph.findPath")
          }}</UiButton>
        </form>
        <UiFlash v-if="graphPathError" tone="danger">{{ graphPathError }}</UiFlash>
        <template v-else-if="graphPath">
          <p v-if="!graphPath.found" class="node-panel__empty">{{ graphPath.reason }}</p>
          <ol v-else class="node-panel__steps" :aria-label="t('graph.connectionPath')">
            <li v-for="(step, index) in graphPath.steps" :key="step.edge.id">
              <span class="node-panel__step-number">{{ index + 1 }}</span>
              <span>
                {{ step.reason }}
                <UiLabel v-if="step.edge.provenance === 'derived'" tone="attention">{{ t("graph.derived") }}</UiLabel>
              </span>
            </li>
          </ol>
        </template>
      </section>

      <section>
        <h3 class="node-panel__heading">{{ t("graph.linkHistory") }}</h3>
        <p v-if="relations.length === 0" class="node-panel__empty">{{ t("graph.thisNodeHasNoOther") }}</p>
        <VirtualList
          v-else
          class="node-panel__relations"
          :items="relations"
          :enabled="true"
          :estimate-item-height="72"
          max-height="min(50vh, 420px)"
          :label="t('graph.graphRelationshipList')"
        >
          <template #default="{ item: relation }">
            <button type="button" class="node-panel__relation" @click="selectGraphNode(relation.relatedNode)">
              <component
                :is="relation.direction === 'outgoing' ? ArrowRight : ArrowLeft"
                :size="16"
                :stroke-width="1.75"
                aria-hidden="true"
              />
              <span class="node-panel__relation-copy">
                <strong>{{ graphNodeDisplayLabel(relation.relatedNode, 40) }}</strong>
                <small>{{ relationDetail(relation.edge, relation.relatedNode) }}</small>
              </span>
            </button>
          </template>
        </VirtualList>
      </section>
    </div>
  </UiSidePanel>
</template>

<style scoped>
.node-panel__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.node-panel__title {
  margin-top: var(--space-2);
  font-size: var(--text-lg);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.node-panel__id {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.node-panel {
  display: grid;
  gap: var(--space-4);
}

.node-panel__meta {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: var(--space-2) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}

.node-panel__meta dt {
  color: var(--fg-muted);
}

.node-panel__meta dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.node-panel__path-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.node-panel__steps {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}

.node-panel__steps li {
  display: flex;
  gap: var(--space-2);
  line-height: 1.6;
}

.node-panel__step-number {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--attention-soft);
  color: var(--attention);
  font-size: var(--text-xs);
  line-height: 22px;
  text-align: center;
}

.node-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.node-panel__actions:empty {
  display: none;
}

.node-panel__heading {
  margin-bottom: var(--space-2);
  font-size: var(--text-md);
  font-weight: 600;
}

.node-panel__empty {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.node-panel__relations {
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.node-panel__relations :deep(.virtual-list-item + .virtual-list-item) {
  border-top: 1px solid var(--border-muted);
}

.node-panel__relation {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: none;
  color: var(--fg);
  text-align: left;
}

.node-panel__relation:hover {
  background: var(--bg-hover);
}

.node-panel__relation :deep(.lucide) {
  color: var(--fg-muted);
}

.node-panel__relation-copy {
  display: grid;
  min-width: 0;
}

.node-panel__relation-copy small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>

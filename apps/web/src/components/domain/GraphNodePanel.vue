<script setup lang="ts">
import { ArrowLeft, ArrowRight, BookOpen, FolderGit2, ListChecks, X } from "lucide-vue-next";
import type { GraphEdge, GraphNode } from "@work-intelligence/core";
import { useGraph } from "../../composables/useGraph";
import { graphEdgeKindLabels, graphNodeKindLabels } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";

/** Docked, non-modal node detail: the graph stays interactive while the panel is open. */
const {
  selectedGraphNode: node,
  selectedGraphNodeMetadata: metadata,
  selectedGraphNodeRelations: relations,
  graphPanelWidth,
  graphNodeProjectName,
  graphNodeDisplayLabel,
  graphNodeDescription,
  selectGraphNode,
  openGraphSession,
  openGraphKnowledge,
  openGraphProject
} = useGraph();

/** Relation subtitle; avoids "變更檔案 · 變更檔案" and shows the folder for files. */
function relationDetail(edge: GraphEdge, related: GraphNode): string {
  const edgeLabel = graphEdgeKindLabels[edge.kind];
  const kindLabel = graphNodeKindLabels[related.kind];
  const context = related.kind === "file" ? graphNodeDescription(related, 48) : kindLabel;
  return edgeLabel === kindLabel && related.kind !== "file" ? edgeLabel : `${edgeLabel} · ${context}`;
}
</script>

<template>
  <UiSidePanel :open="Boolean(node)" :modal="false" :width="460" storage-key="graph-node" label="Graph 節點詳細資料" @close="selectGraphNode(null)" @resize="graphPanelWidth = $event">
    <template v-if="node" #header>
      <div class="node-panel__top">
        <UiLabel tone="accent">{{ graphNodeKindLabels[node.kind] }}</UiLabel>
        <UiIconButton :icon="X" label="關閉 Graph 節點詳細資料" @click="selectGraphNode(null)" />
      </div>
      <h2 class="node-panel__title">{{ node.label }}</h2>
      <code class="node-panel__id">{{ node.id }}</code>
    </template>

    <div v-if="node" class="node-panel">
      <dl class="node-panel__meta">
        <dt>來源專案</dt><dd>{{ graphNodeProjectName(node) }}</dd>
        <dt>關係數</dt><dd>{{ relations.length }}</dd>
        <template v-for="item in metadata" :key="item.key">
          <dt>{{ item.label }}</dt><dd class="mono">{{ item.value }}</dd>
        </template>
      </dl>

      <div class="node-panel__actions">
        <UiButton v-if="node.sessionId" size="sm" :icon="ListChecks" @click="openGraphSession(node)">查看 Session 詳情</UiButton>
        <UiButton v-if="node.kind === 'knowledge'" size="sm" :icon="BookOpen" @click="openGraphKnowledge(node)">維護 Knowledge</UiButton>
        <UiButton v-if="node.kind === 'project'" size="sm" :icon="FolderGit2" @click="openGraphProject">管理專案</UiButton>
      </div>

      <section>
        <h3 class="node-panel__heading">關聯紀錄</h3>
        <p v-if="relations.length === 0" class="node-panel__empty">這個節點目前沒有其他已保存的關係。</p>
        <ul v-else class="node-panel__relations">
          <li v-for="relation in relations" :key="relation.edge.id">
            <button type="button" class="node-panel__relation" @click="selectGraphNode(relation.relatedNode)">
              <component :is="relation.direction === 'outgoing' ? ArrowRight : ArrowLeft" :size="16" :stroke-width="1.75" aria-hidden="true" />
              <span class="node-panel__relation-copy">
                <strong>{{ graphNodeDisplayLabel(relation.relatedNode, 40) }}</strong>
                <small>{{ relationDetail(relation.edge, relation.relatedNode) }}</small>
              </span>
            </button>
          </li>
        </ul>
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
  list-style: none;
}

.node-panel__relations li + li {
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

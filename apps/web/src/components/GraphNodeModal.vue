<script setup lang="ts">
import { useGraph } from "../composables/useGraph";
import { graphNodeLabel } from "../utils/format";
import { graphEdgeKindLabels, graphNodeKindLabels } from "../utils/labels";
import BaseModal from "./BaseModal.vue";

const {
  selectedGraphNode,
  selectedGraphNodeMetadata,
  selectedGraphNodeRelations,
  graphNodeProjectName,
  selectGraphNode,
  openGraphSession,
  openGraphKnowledge,
  openGraphProject
} = useGraph();
</script>

<template>
  <BaseModal :open="Boolean(selectedGraphNode)" ariaLabel="Graph 節點詳細資料" panel-class="graph-node-modal" @close="selectGraphNode(null)">
    <template v-if="selectedGraphNode">
      <header class="detail-modal-header">
        <div>
          <div class="eyebrow">GRAPH NODE DETAIL</div>
          <span :class="['graph-node-type-chip', `graph-node-type-${selectedGraphNode.kind}`]">{{ graphNodeKindLabels[selectedGraphNode.kind] }}</span>
        </div>
        <button class="close-button" type="button" aria-label="關閉 Graph 節點詳細資料" @click="selectGraphNode(null)">×</button>
      </header>
      <div class="detail-modal-content graph-node-modal-content">
        <div class="graph-node-detail-heading">
          <span :class="['graph-node-detail-icon', `graph-node-detail-icon-${selectedGraphNode.kind}`]" aria-hidden="true">{{ selectedGraphNode.kind.slice(0, 1).toUpperCase() }}</span>
          <div>
            <h2>{{ selectedGraphNode.label }}</h2>
            <code>{{ selectedGraphNode.id }}</code>
          </div>
        </div>

        <div class="detail-facts graph-node-facts">
          <div><span>節點類型</span><strong>{{ graphNodeKindLabels[selectedGraphNode.kind] }}</strong></div>
          <div><span>來源專案</span><strong>{{ graphNodeProjectName(selectedGraphNode) }}</strong></div>
          <div><span>關係數</span><strong>{{ selectedGraphNodeRelations.length }}</strong></div>
        </div>

        <div v-if="selectedGraphNodeMetadata.length" class="detail-section">
          <div class="eyebrow">STORED METADATA</div>
          <dl class="graph-node-metadata">
            <div v-for="item in selectedGraphNodeMetadata" :key="item.key">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>
        </div>

        <div class="detail-section">
          <div class="eyebrow">RELATED RECORDS</div>
          <div v-if="selectedGraphNodeRelations.length" class="graph-node-relations">
            <button
              v-for="relation in selectedGraphNodeRelations"
              :key="relation.edge.id"
              class="graph-node-relation"
              type="button"
              @click="selectGraphNode(relation.relatedNode)"
            >
              <span class="graph-relation-direction" aria-hidden="true">{{ relation.direction === 'outgoing' ? '→' : '←' }}</span>
              <span class="graph-node-relation-copy">
                <strong>{{ graphNodeLabel(relation.relatedNode.label) }}</strong>
                <small>{{ graphEdgeKindLabels[relation.edge.kind] }} · {{ graphNodeKindLabels[relation.relatedNode.kind] }}</small>
              </span>
              <span class="graph-relation-open" aria-hidden="true">↗</span>
            </button>
          </div>
          <div v-else class="graph-node-no-relations">這個節點目前沒有其他已保存的關係。</div>
        </div>

        <footer class="graph-node-actions">
          <button v-if="selectedGraphNode.sessionId" class="outline-button" type="button" @click="openGraphSession(selectedGraphNode)">查看 Session 詳情</button>
          <button v-if="selectedGraphNode.kind === 'knowledge'" class="outline-button" type="button" @click="openGraphKnowledge(selectedGraphNode)">維護 Knowledge</button>
          <button v-if="selectedGraphNode.kind === 'project'" class="outline-button" type="button" @click="openGraphProject">管理專案</button>
        </footer>
      </div>
    </template>
  </BaseModal>
</template>

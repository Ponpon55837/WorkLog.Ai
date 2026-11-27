<script setup lang="ts">
import { storeToRefs } from "pinia";
import { Bot } from "lucide-vue-next";
import type { AgentReviewedKnowledge, ProjectRecord } from "@work-intelligence/core";
import AgentReviewFilter from "./AgentReviewFilter.vue";
import AgentReviewVerdict from "./AgentReviewVerdict.vue";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useAgentReviewStore } from "../../stores/agent-review";
import { knowledgeKindVisual } from "../../utils/status";
import { t } from "../../i18n";

const props = defineProps<{ projects: readonly ProjectRecord[]; projectRoot?: string }>();

const { filter, reviewedKnowledge, reviewedKnowledgeLoaded, reviewedKnowledgeError } =
  storeToRefs(useAgentReviewStore());
const { overturn } = useAgentReviewActions();

function projectRootFor(item: AgentReviewedKnowledge): string | undefined {
  return props.projectRoot ?? props.projects.find((project) => project.id === item.knowledge.projectId)?.rootPath;
}
</script>

<template>
  <UiBox data-testid="agent-knowledge-review" sticky-header>
    <template #header>
      <UiBoxTitle
        :icon="Bot"
        :title="t('knowledge.agentProcessedKnowledge')"
        :count="reviewedKnowledgeLoaded ? reviewedKnowledge.length : undefined"
      />
      <AgentReviewFilter v-model="filter" :pending-label="t('knowledge.reviewFilterAllKnowledge')" />
    </template>
    <UiFlash v-if="reviewedKnowledgeError" tone="danger">{{ reviewedKnowledgeError }}</UiFlash>
    <UiSkeleton v-else-if="!reviewedKnowledgeLoaded" :count="3" :label="t('knowledge.loadingKnowledge')" />
    <UiEmptyState
      v-else-if="reviewedKnowledge.length === 0"
      :icon="Bot"
      :title="t('knowledge.noAgentProcessedKnowledge')"
      :description="t('knowledge.agentProcessedKnowledgeHint')"
    />
    <VirtualList
      v-else
      :items="reviewedKnowledge"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="132"
      :label="t('knowledge.agentProcessedKnowledgeList')"
    >
      <template #default="{ item }">
        <UiBoxRow tag="article" data-testid="agent-knowledge-item">
          <template #title>{{ item.knowledge.title }}</template>
          <template #labels>
            <StatusLabel :status="knowledgeKindVisual[item.knowledge.kind]" :show-icon="false" />
          </template>
          <AgentReviewVerdict
            :verdict="item.verdict"
            :reason="item.reason"
            :reviewed-at="item.reviewedAt"
            @overturn="overturn('knowledge', item.knowledge.id, projectRootFor(item), item.verdict)"
          />
          <p v-if="item.successor" class="agent-knowledge__successor" data-testid="agent-knowledge-successor">
            {{ t("knowledge.replacedBy", { title: item.successor.title }) }}
          </p>
        </UiBoxRow>
      </template>
    </VirtualList>
  </UiBox>
</template>

<style scoped>
.agent-knowledge__successor {
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>

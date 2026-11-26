<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Bot } from "lucide-vue-next";
import type { AgentReviewedKnowledge, ProjectRecord } from "@work-intelligence/core";
import AgentReviewVerdict from "./AgentReviewVerdict.vue";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiFlash from "../ui/UiFlash.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useAgentReviewStore } from "../../stores/agent-review";
import { knowledgeKindVisual } from "../../utils/status";
import { t } from "../../i18n";

/**
 * Active Knowledge an Agent confirmed, archived, or replaced. The verdict and its reason are shown next to the
 * Knowledge so a person can overturn it; the box stays hidden while the Agent has processed none.
 */
const props = defineProps<{ projects: readonly ProjectRecord[]; projectRoot?: string }>();

const { reviewedKnowledge, reviewedKnowledgeError } = storeToRefs(useAgentReviewStore());
const { overturn } = useAgentReviewActions();

const visible = computed(() => Boolean(reviewedKnowledgeError.value) || reviewedKnowledge.value.length > 0);

function projectRootFor(item: AgentReviewedKnowledge): string | undefined {
  return props.projectRoot ?? props.projects.find((project) => project.id === item.knowledge.projectId)?.rootPath;
}
</script>

<template>
  <UiBox v-if="visible" class="agent-knowledge" data-testid="agent-knowledge-review">
    <template #header>
      <UiBoxTitle :icon="Bot" :title="t('knowledge.agentProcessedKnowledge')" :count="reviewedKnowledge.length" />
    </template>
    <UiFlash v-if="reviewedKnowledgeError" tone="danger">{{ reviewedKnowledgeError }}</UiFlash>
    <div class="agent-knowledge__list" role="list" :aria-label="t('knowledge.agentProcessedKnowledgeList')">
      <UiBoxRow
        v-for="item in reviewedKnowledge"
        :key="item.knowledge.id"
        tag="article"
        role="listitem"
        data-testid="agent-knowledge-item"
      >
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
    </div>
  </UiBox>
</template>

<style scoped>
.agent-knowledge {
  margin-bottom: var(--space-4);
}

.agent-knowledge__list {
  max-height: 360px;
  overflow-y: auto;
}

.agent-knowledge__successor {
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>

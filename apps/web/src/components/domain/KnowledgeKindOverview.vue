<script setup lang="ts">
import { computed } from "vue";
import { Shapes } from "lucide-vue-next";
import type { KnowledgeKind, KnowledgeStatus } from "@work-intelligence/core";
import { knowledgeKindLabels, knowledgeStatusLabels } from "../../utils/labels";
import { knowledgeKindVisual } from "../../utils/status";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiMeter from "../ui/UiMeter.vue";
import { t } from "../../i18n";

/** Knowledge per kind for the selected project and status; counts come from the API, never estimated. */
const props = defineProps<{
  counts: Record<KnowledgeKind, number>;
  status: KnowledgeStatus;
  /** A text search narrows the list but not these counts. */
  searchActive?: boolean;
}>();

const kinds = Object.keys(knowledgeKindLabels) as KnowledgeKind[];
const total = computed(() => kinds.reduce((sum, kind) => sum + props.counts[kind], 0));
</script>

<template>
  <UiBox data-testid="knowledge-kind-overview">
    <template #header>
      <UiBoxTitle :icon="Shapes" :title="t('knowledge.kindOverview')" />
    </template>
    <ul class="kind-overview">
      <li v-for="kind in kinds" :key="kind" class="kind-overview__item">
        <span class="kind-overview__name">{{ knowledgeKindLabels[kind] }}</span>
        <span class="kind-overview__count">{{ counts[kind] }}</span>
        <UiMeter
          class="kind-overview__meter"
          size="sm"
          :max="total"
          :segments="[{ value: counts[kind], tone: knowledgeKindVisual[kind].tone, label: knowledgeKindLabels[kind] }]"
        />
      </li>
    </ul>
    <p class="kind-overview__note">
      {{ t("knowledge.kindOverviewNote", { status: knowledgeStatusLabels[status], total }) }}
      <template v-if="searchActive">{{ t("knowledge.kindOverviewIgnoresSearch") }}</template>
    </p>
  </UiBox>
</template>

<style scoped>
.kind-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-4);
  list-style: none;
}

.kind-overview__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: var(--space-3);
  font-size: var(--text-sm);
}

.kind-overview__name {
  color: var(--fg);
}

.kind-overview__count {
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.kind-overview__meter {
  grid-column: 1 / -1;
}

.kind-overview__note {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}
</style>

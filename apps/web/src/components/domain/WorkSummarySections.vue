<script setup lang="ts">
import type { WorkSummarySections } from "@work-intelligence/core";
import { workSummarySectionLabels } from "../../utils/labels";

/**
 * The five workSummary sections in fixed order. `nextSteps` is shown as 狀態／未結項 and never
 * styled as a recommendation. Legacy Sessions without workSummary still show all five headings.
 */
defineProps<{ summary?: WorkSummarySections }>();
</script>

<template>
  <div class="work-summary" data-testid="session-work-summary">
    <p v-if="!summary" class="work-summary__legacy">此 Session 尚未提供五段摘要。</p>
    <section v-for="section in workSummarySectionLabels" :key="section.key" class="work-summary__section">
      <h3>
        {{ section.label }} <span class="work-summary__key">{{ section.key }}</span>
      </h3>
      <ul v-if="summary?.[section.key]?.length">
        <li v-for="(item, index) in summary[section.key]" :key="index">{{ item }}</li>
      </ul>
      <p v-else class="work-summary__empty">—</p>
    </section>
  </div>
</template>

<style scoped>
.work-summary {
  display: grid;
  gap: var(--space-4);
}

.work-summary__legacy {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.work-summary__section h3 {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
}

.work-summary__key {
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.work-summary__section ul {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding-left: 20px;
  line-height: 1.6;
}

.work-summary__section li::marker {
  color: var(--fg-subtle);
}

.work-summary__empty {
  color: var(--fg-muted);
}
</style>

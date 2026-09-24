<script setup lang="ts">
import type { ReportSummaryBlock } from "@work-intelligence/core";

/** One synthesis section. Every item cites its source Sessions; `資料不足` is shown as-is. */
defineProps<{ title: string; hint?: string; blocks: readonly ReportSummaryBlock[] }>();
const emit = defineEmits<{ openSources: [sessionIds: string[]] }>();

function isInsufficient(detail: string): boolean {
  return detail.includes("資料不足");
}
</script>

<template>
  <section class="synthesis-block">
    <h3>
      {{ title }} <span v-if="hint" class="synthesis-block__hint">{{ hint }}</span>
    </h3>
    <div v-for="(block, index) in blocks" :key="`${block.title}-${index}`" class="synthesis-block__item">
      <div class="synthesis-block__copy">
        <strong>{{ block.title }}</strong>
        <p :class="{ 'is-insufficient': isInsufficient(block.detail) }">{{ block.detail }}</p>
      </div>
      <button
        v-if="block.sourceSessionIds.length"
        type="button"
        class="synthesis-block__sources"
        :title="`查看 ${block.sourceSessionIds.length} 個來源 Session`"
        @click="emit('openSources', block.sourceSessionIds)"
      >
        {{ block.sourceSessionIds.length }} Session{{ block.sourceSessionIds.length > 1 ? "s" : "" }}
      </button>
      <span v-else class="synthesis-block__no-source">未提供來源</span>
    </div>
  </section>
</template>

<style scoped>
.synthesis-block h3 {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
}

.synthesis-block__hint {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 400;
}

.synthesis-block__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border-muted);
}

.synthesis-block__copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.synthesis-block__copy strong {
  font-weight: 600;
}

.synthesis-block__copy p {
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-line;
}

.synthesis-block__copy p.is-insufficient {
  color: var(--attention);
}

.synthesis-block__sources {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--accent);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.synthesis-block__sources:hover {
  background: var(--accent-soft);
}

.synthesis-block__no-source {
  flex: 0 0 auto;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>

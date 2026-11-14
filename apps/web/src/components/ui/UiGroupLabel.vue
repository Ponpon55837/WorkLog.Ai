<script setup lang="ts">
defineProps<{ summary?: string }>();
</script>

<template>
  <!-- `summary` (prop or slot) is the small muted recap beside the title, e.g. the day's total. -->
  <div class="ui-group-label" role="presentation">
    <slot />
    <span v-if="summary || $slots.summary" class="ui-group-label__summary"
      ><slot name="summary">{{ summary }}</slot></span
    >
  </div>
</template>

<style scoped>
.ui-group-label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--space-3);
  padding: 6px var(--space-4);
  border-top: 1px solid var(--border-muted);
  background: var(--bg-canvas);
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 500;
}

.ui-group-label__summary {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 400;
}

.ui-group-label:first-child {
  border-top: 0;
}
</style>

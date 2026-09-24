<script setup lang="ts">
import { computed } from "vue";

/** Tiny bar sparkline; the last bar is emphasised. Values are rendered as-is (no smoothing). */
const props = defineProps<{ values: readonly number[]; label: string }>();
const max = computed(() => Math.max(1, ...props.values));
</script>

<template>
  <div class="ui-sparkline" role="img" :aria-label="label">
    <span
      v-for="(value, index) in values"
      :key="index"
      :style="{ height: `${Math.max(8, (value / max) * 100)}%` }"
      :title="String(value)"
    ></span>
  </div>
</template>

<style scoped>
.ui-sparkline {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 24px;
  margin-top: var(--space-2);
}

.ui-sparkline span {
  flex: 1;
  border-radius: 2px;
  background: var(--accent-border);
}

.ui-sparkline span:last-child {
  background: var(--accent);
}
</style>

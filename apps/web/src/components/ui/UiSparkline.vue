<script setup lang="ts">
import { computed } from "vue";

/** Tiny bar sparkline; the last bar is emphasised. Values are rendered as-is (no smoothing). */
const props = withDefaults(
  defineProps<{
    values: readonly number[];
    label: string;
    /** `lg` is the 52px chart for `UiStatCard featured`. */ size?: "md" | "lg";
  }>(),
  { size: "md" },
);
const max = computed(() => Math.max(1, ...props.values));
</script>

<template>
  <div :class="['ui-sparkline', `ui-sparkline--${size}`]" role="img" :aria-label="label">
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

.ui-sparkline--lg {
  gap: var(--space-1);
  height: 52px;
}

.ui-sparkline span {
  flex: 1;
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  background: var(--accent-border);
}

.ui-sparkline span:last-child {
  background: var(--accent);
}
</style>

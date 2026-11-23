<script setup lang="ts">
import { computed } from "vue";
import type { ChartTone } from "./types";

/**
 * Horizontal meter. Segment widths are proportional to their sum, or to `max` when given (a single
 * segment then reads as progress toward `max`). `size="sm"` is the thin row-level bar. Without `label`
 * the meter is decorative and hidden from assistive technology. `gap` separates touching segments with a 2px
 * surface-colored gap (for part-to-whole bars) instead of letting their colors meet.
 */
const props = withDefaults(
  defineProps<{
    segments: readonly { value: number; tone: ChartTone; label: string }[];
    label?: string;
    max?: number;
    size?: "md" | "sm";
    gap?: boolean;
  }>(),
  { size: "md", gap: false },
);
const total = computed(() => props.max ?? props.segments.reduce((sum, segment) => sum + segment.value, 0));
const gapIndex = computed(() => {
  const visible = props.segments.flatMap((segment, index) => (segment.value > 0 ? [index] : []));
  return new Set(props.gap ? visible.slice(1) : []);
});
</script>

<template>
  <div
    :class="['ui-meter', `ui-meter--${size}`]"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <i
      v-for="(segment, index) in segments"
      :key="segment.label"
      :class="[`tone-${segment.tone}`, { 'has-gap': gapIndex.has(index) }]"
      :style="{ width: total ? `${Math.min(100, (segment.value / total) * 100)}%` : '0%' }"
      :title="`${segment.label} ${segment.value}`"
    ></i>
  </div>
</template>

<style scoped>
.ui-meter {
  display: flex;
  height: 6px;
  margin-top: var(--space-3);
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
}

.ui-meter--sm {
  height: 4px;
  margin-top: var(--space-2);
}

.ui-meter i {
  display: block;
  height: 100%;
}

.has-gap {
  box-shadow: inset 2px 0 0 var(--bg-surface);
}

.tone-success {
  background: var(--success);
}
.tone-danger {
  background: var(--danger);
}
.tone-attention {
  background: var(--attention);
}
.tone-neutral {
  background: var(--fg-subtle);
}
.tone-accent {
  background: var(--accent);
}
.tone-done {
  background: var(--done);
}
.tone-diagram-5 {
  background: var(--diagram-tone-5);
}
.tone-diagram-6 {
  background: var(--diagram-tone-6);
}
</style>

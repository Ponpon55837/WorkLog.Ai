<script setup lang="ts">
import { computed } from "vue";
import type { Tone } from "./types";

/**
 * Horizontal meter. Segment widths are proportional to their sum, or to `max` when given (a single
 * segment then reads as progress toward `max`). `size="sm"` is the thin row-level bar. Without `label`
 * the meter is decorative and hidden from assistive technology.
 */
const props = withDefaults(
  defineProps<{
    segments: readonly { value: number; tone: Tone; label: string }[];
    label?: string;
    max?: number;
    size?: "md" | "sm";
  }>(),
  { size: "md" },
);
const total = computed(() => props.max ?? props.segments.reduce((sum, segment) => sum + segment.value, 0));
</script>

<template>
  <div
    :class="['ui-meter', `ui-meter--${size}`]"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <i
      v-for="segment in segments"
      :key="segment.label"
      :class="`tone-${segment.tone}`"
      :style="{ width: total ? `${Math.min(100, (segment.value / total) * 100)}%` : '0%' }"
      :title="`${segment.label} ${segment.value}`"
    ></i>
  </div>
</template>

<style scoped>
.ui-meter {
  display: flex;
  height: 8px;
  margin-top: var(--space-3);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
}

.ui-meter--sm {
  height: 6px;
  margin-top: var(--space-2);
}

.ui-meter i {
  display: block;
  height: 100%;
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
</style>

<script setup lang="ts">
import { computed } from "vue";
import type { Tone } from "./types";

/** Segmented horizontal meter; segment widths are proportional to their values. */
const props = defineProps<{ segments: readonly { value: number; tone: Tone; label: string }[]; label: string }>();
const total = computed(() => props.segments.reduce((sum, segment) => sum + segment.value, 0));
</script>

<template>
  <div class="ui-meter" role="img" :aria-label="label">
    <i
      v-for="segment in segments"
      :key="segment.label"
      :class="`tone-${segment.tone}`"
      :style="{ width: total ? `${(segment.value / total) * 100}%` : '0%' }"
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

.ui-meter i {
  display: block;
  height: 100%;
}

.tone-success { background: var(--success); }
.tone-danger { background: var(--danger); }
.tone-attention { background: var(--attention); }
.tone-neutral { background: var(--fg-subtle); }
.tone-accent { background: var(--accent); }
.tone-done { background: var(--done); }
</style>

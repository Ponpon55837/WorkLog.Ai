<script setup lang="ts">
import type { IconComponent, Tone } from "./types";

withDefaults(defineProps<{ tone?: Tone; icon?: IconComponent }>(), { tone: "neutral" });
</script>

<template>
  <span :class="['ui-label', `ui-label--${tone}`]">
    <component :is="icon" v-if="icon" :size="12" :stroke-width="2" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.ui-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 20px;
  max-width: 100%;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-label--accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.ui-label--success {
  background: var(--success-soft);
  color: var(--success);
}
.ui-label--attention {
  background: var(--attention-soft);
  color: var(--attention);
}
.ui-label--danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.ui-label--done {
  background: var(--done-soft);
  color: var(--done);
}
</style>

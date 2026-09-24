<script setup lang="ts">
import { ChevronRight } from "lucide-vue-next";
import type { IconComponent } from "./types";
import UiCounter from "./UiCounter.vue";

/** Collapsible bordered section (native <details>) used for secondary detail blocks. */
withDefaults(defineProps<{ title: string; icon?: IconComponent; count?: number; hint?: string; open?: boolean }>(), {
  open: false,
});
</script>

<template>
  <details class="ui-disclosure" :open="open">
    <summary>
      <ChevronRight :size="16" :stroke-width="1.75" class="ui-disclosure__chevron" aria-hidden="true" />
      <component
        :is="icon"
        v-if="icon"
        :size="16"
        :stroke-width="1.75"
        class="ui-disclosure__icon"
        aria-hidden="true"
      />
      <span class="ui-disclosure__title">{{ title }}</span>
      <UiCounter v-if="count !== undefined" :count="count" />
      <span v-if="hint" class="ui-disclosure__hint">{{ hint }}</span>
    </summary>
    <div class="ui-disclosure__body"><slot /></div>
  </details>
</template>

<style scoped>
.ui-disclosure {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.ui-disclosure + .ui-disclosure {
  margin-top: var(--space-3);
}

summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-subtle);
  cursor: pointer;
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

.ui-disclosure[open] summary {
  border-bottom: 1px solid var(--border-muted);
}

.ui-disclosure__chevron {
  color: var(--fg-muted);
  transition: transform 0.15s;
}

.ui-disclosure[open] .ui-disclosure__chevron {
  transform: rotate(90deg);
}

.ui-disclosure__icon {
  color: var(--fg-muted);
}

.ui-disclosure__title {
  font-weight: 600;
}

.ui-disclosure__hint {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>

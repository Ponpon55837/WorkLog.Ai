<script setup lang="ts">
import type { IconComponent } from "./types";

defineProps<{ eyebrow?: string; title: string; icon?: IconComponent; count?: number | string }>();
</script>

<template>
  <div class="ui-box-title">
    <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" class="ui-box-title__icon" aria-hidden="true" />
    <span v-if="eyebrow" class="ui-box-title__eyebrow">{{ eyebrow }}</span>
    <h2 class="ui-box-title__text">{{ title }}</h2>
    <span v-if="count !== undefined" class="ui-box-title__count">{{ count }}</span>
    <slot />
  </div>
</template>

<style scoped>
.ui-box-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.ui-box-title__icon {
  color: var(--fg-muted);
}

.ui-box-title__eyebrow {
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ui-box-title__text {
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
}

.ui-box-title__count {
  color: var(--fg-muted);
  font-size: var(--text-md);
}
</style>

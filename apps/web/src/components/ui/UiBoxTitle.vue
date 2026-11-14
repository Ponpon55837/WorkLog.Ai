<script setup lang="ts">
import type { IconComponent } from "./types";

defineProps<{ title: string; icon?: IconComponent; count?: number | string }>();
</script>

<template>
  <div class="ui-box-title">
    <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" class="ui-box-title__icon" aria-hidden="true" />
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

.ui-box-title__text {
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
}

.ui-box-title__count {
  padding: 0 7px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
</style>

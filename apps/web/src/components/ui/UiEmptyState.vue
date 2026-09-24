<script setup lang="ts">
import type { IconComponent } from "./types";

withDefaults(defineProps<{ icon?: IconComponent; title: string; description?: string; compact?: boolean }>(), {
  compact: false,
});
</script>

<template>
  <div :class="['ui-empty', { 'ui-empty--compact': compact }]">
    <component :is="icon" v-if="icon" :size="24" :stroke-width="1.5" class="ui-empty__icon" aria-hidden="true" />
    <strong>{{ title }}</strong>
    <p v-if="description || $slots.default">
      <slot>{{ description }}</slot>
    </p>
    <div v-if="$slots.action" class="ui-empty__action"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.ui-empty {
  display: grid;
  justify-items: center;
  gap: var(--space-1);
  padding: var(--space-12) var(--space-6);
  color: var(--fg-muted);
  text-align: center;
}

.ui-empty--compact {
  padding: var(--space-6) var(--space-4);
}

.ui-empty__icon {
  margin-bottom: var(--space-2);
  color: var(--fg-muted);
}

.ui-empty strong {
  color: var(--fg);
  font-size: var(--text-lg);
  font-weight: 600;
}

.ui-empty p {
  max-width: 420px;
  font-size: var(--text-md);
}

.ui-empty__action {
  margin-top: var(--space-3);
}
</style>

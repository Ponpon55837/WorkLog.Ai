<script setup lang="ts">
import UiCheckbox from "./UiCheckbox.vue";

defineProps<{
  label: string;
  selectText: string;
  groupLabel: string;
  summary: string;
  count: number;
  indeterminate?: boolean;
  disabled?: boolean;
  toolbarTestid?: string;
  summaryTestid?: string;
}>();

const allSelected = defineModel<boolean>({ required: true });
</script>

<template>
  <div class="ui-selection-bar">
    <label class="ui-selection-bar__select">
      <UiCheckbox v-model="allSelected" :label="label" :indeterminate="indeterminate" :disabled="disabled" />
      <span v-if="count === 0">{{ selectText }}</span>
    </label>
    <div
      v-if="count > 0"
      class="ui-selection-bar__actions"
      role="group"
      :aria-label="groupLabel"
      :data-testid="toolbarTestid"
    >
      <span aria-live="polite" :data-testid="summaryTestid">{{ summary }}</span>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-selection-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-8);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.ui-selection-bar__select {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
}

.ui-selection-bar__actions {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
</style>

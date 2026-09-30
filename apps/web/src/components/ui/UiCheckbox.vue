<script setup lang="ts">
/** Native keyboard-accessible checkbox, including mixed selection for a group. */
withDefaults(defineProps<{ label: string; disabled?: boolean; indeterminate?: boolean }>(), {
  disabled: false,
  indeterminate: false,
});
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <input
    v-model="model"
    class="ui-checkbox"
    type="checkbox"
    :aria-label="label"
    :disabled="disabled"
    :indeterminate="indeterminate"
    :aria-checked="indeterminate ? 'mixed' : model"
  />
</template>

<style scoped>
.ui-checkbox {
  flex-shrink: 0;
  width: var(--space-4);
  height: var(--space-4);
  margin: var(--space-1);
  accent-color: var(--accent-emphasis);
  cursor: pointer;
}
.ui-checkbox:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ui-checkbox:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>

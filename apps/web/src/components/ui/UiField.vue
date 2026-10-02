<script setup lang="ts">
import { useId } from "vue";

/**
 * A labelled form field. `group` is for controls that are themselves a set of buttons (UiSegmentedControl): a
 * wrapping <label> would hand its text to the first button only, so the field becomes a labelled group instead.
 */
defineProps<{ label: string; hint?: string; error?: string; group?: boolean }>();

const labelId = useId();
const hintId = useId();
</script>

<template>
  <component
    :is="group ? 'div' : 'label'"
    class="ui-field"
    :role="group ? 'group' : undefined"
    :aria-labelledby="group ? labelId : undefined"
    :aria-describedby="group && (error || hint) ? hintId : undefined"
  >
    <span :id="labelId" class="ui-field__label">{{ label }}</span>
    <slot />
    <span v-if="error" :id="hintId" class="ui-field__error" role="alert">{{ error }}</span>
    <span v-else-if="hint" :id="hintId" class="ui-field__hint">{{ hint }}</span>
  </component>
</template>

<style scoped>
.ui-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.ui-field__label {
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 600;
}

.ui-field__hint {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-field__error {
  color: var(--danger);
  font-size: var(--text-xs);
}
</style>

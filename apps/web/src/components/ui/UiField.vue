<script setup lang="ts">
defineProps<{ label: string; hint?: string; error?: string }>();
</script>

<template>
  <label class="ui-field">
    <span class="ui-field__label">{{ label }}</span>
    <slot />
    <span v-if="error" class="ui-field__error" role="alert">{{ error }}</span>
    <span v-else-if="hint" class="ui-field__hint">{{ hint }}</span>
  </label>
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

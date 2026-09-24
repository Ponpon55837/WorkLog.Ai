<script setup lang="ts">
withDefaults(
  defineProps<{ rows?: number; placeholder?: string; maxlength?: number; required?: boolean; mono?: boolean }>(),
  { rows: 4 },
);

const model = defineModel<string>({ default: "" });
</script>

<template>
  <textarea
    v-model="model"
    :class="['ui-textarea', { mono }]"
    :rows="rows"
    :placeholder="placeholder"
    :maxlength="maxlength"
    :required="required"
  ></textarea>
</template>

<style scoped>
.ui-textarea {
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
  color: var(--fg);
  font-size: var(--text-md);
  line-height: 1.6;
  resize: vertical;
}

.ui-textarea:focus {
  border-color: var(--accent-emphasis);
  outline: 0;
  box-shadow: inset 0 0 0 1px var(--accent-emphasis);
}

.ui-textarea.mono {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
</style>

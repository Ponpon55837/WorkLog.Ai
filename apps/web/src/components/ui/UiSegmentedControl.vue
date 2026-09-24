<script setup lang="ts" generic="T extends string | number">
import type { SelectOption } from "./types";

defineProps<{ options: readonly SelectOption<T>[]; label: string }>();
const model = defineModel<T>({ required: true });

function onKeydown(event: KeyboardEvent, options: readonly SelectOption<T>[]): void {
  const index = options.findIndex((option) => option.value === model.value);
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) {
    return;
  }
  event.preventDefault();
  const next = options[(index + step + options.length) % options.length];
  if (next) {
    model.value = next.value;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${String(next.value)}"]`)?.focus();
  }
}
</script>

<template>
  <div class="ui-segmented" role="radiogroup" :aria-label="label" @keydown="onKeydown($event, options)">
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      role="radio"
      :data-value="String(option.value)"
      :aria-checked="model === option.value"
      :tabindex="model === option.value ? 0 : -1"
      :class="{ 'is-selected': model === option.value }"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
}

.ui-segmented button {
  height: 26px;
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  white-space: nowrap;
}

.ui-segmented button:hover {
  color: var(--fg);
}

.ui-segmented button.is-selected {
  border-color: var(--border);
  background: var(--bg-canvas);
  color: var(--fg);
  font-weight: 600;
}
</style>

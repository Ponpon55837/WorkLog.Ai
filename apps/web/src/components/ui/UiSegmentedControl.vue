<script setup lang="ts" generic="T extends string | number">
import type { SelectOption } from "./types";

/** `size` follows the control heights: `md` is 32px like a button, `sm` is 28px for UiBox headers. */
withDefaults(defineProps<{ options: readonly SelectOption<T>[]; label: string; size?: "md" | "sm" }>(), { size: "md" });
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
  <div
    :class="['ui-segmented', `ui-segmented--${size}`]"
    role="radiogroup"
    :aria-label="label"
    @keydown="onKeydown($event, options)"
  >
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
  /* Longer translations must not push the page wider; the track scrolls instead. */
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-surface);
}

.ui-segmented button {
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-md);
  white-space: nowrap;
  transition:
    background-color var(--duration-instant) ease-out,
    border-color var(--duration-instant) ease-out,
    color var(--duration-instant) ease-out;
}

.ui-segmented--sm button {
  height: 22px;
  font-size: var(--text-sm);
}

.ui-segmented button:hover {
  color: var(--fg);
}

.ui-segmented button.is-selected {
  background: var(--bg-muted);
  color: var(--fg);
  font-weight: 500;
}

@media (max-width: 639px) {
  .ui-segmented button {
    padding: 0 var(--space-2);
  }
}
</style>

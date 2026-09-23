<script setup lang="ts" generic="T extends string">
import type { SelectOption } from "./types";
import UiCounter from "./UiCounter.vue";

/** Tab strip. Tabs expose role="tab"; pair each panel with id `${idPrefix}-panel-${value}`. */
defineProps<{ items: readonly SelectOption<T>[]; label: string; idPrefix: string }>();
const model = defineModel<T>({ required: true });

function onKeydown(event: KeyboardEvent, items: readonly SelectOption<T>[]): void {
  const index = items.findIndex((item) => item.value === model.value);
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) {
    return;
  }
  event.preventDefault();
  const next = items[(index + step + items.length) % items.length];
  if (next) {
    model.value = next.value;
    ((event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next.value}"]`))?.focus();
  }
}
</script>

<template>
  <nav class="ui-underline-nav" role="tablist" :aria-label="label" @keydown="onKeydown($event, items)">
    <button
      v-for="item in items"
      :id="`${idPrefix}-tab-${item.value}`"
      :key="item.value"
      type="button"
      role="tab"
      :data-value="item.value"
      :aria-selected="model === item.value"
      :aria-controls="`${idPrefix}-panel-${item.value}`"
      :tabindex="model === item.value ? 0 : -1"
      :class="{ 'is-selected': model === item.value }"
      @click="model = item.value"
    >
      <component :is="item.icon" v-if="item.icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
      <span>{{ item.label }}</span>
      <UiCounter v-if="item.count !== undefined" :count="item.count" />
    </button>
  </nav>
</template>

<style scoped>
.ui-underline-nav {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
  border-bottom: 1px solid var(--border-muted);
  overflow-x: auto;
  scrollbar-width: none;
}

.ui-underline-nav button {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  padding: 0 var(--space-2);
  border: 0;
  background: none;
  color: var(--fg);
  font-size: var(--text-md);
  white-space: nowrap;
}

.ui-underline-nav button :deep(.lucide) {
  color: var(--fg-muted);
}

.ui-underline-nav button::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: var(--radius);
  background: transparent;
}

.ui-underline-nav button:hover::after {
  background: var(--border);
}

.ui-underline-nav button.is-selected {
  font-weight: 600;
}

.ui-underline-nav button.is-selected::after {
  background: var(--underline-active);
}

.ui-underline-nav button:focus-visible {
  outline-offset: -4px;
}
</style>

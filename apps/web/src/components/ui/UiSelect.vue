<script setup lang="ts" generic="T extends string | number">
import { ChevronDown } from "lucide-vue-next";
import type { IconComponent, SelectOption } from "./types";

/** Native <select> styled to tokens. Use for forms and compact toolbars; list filters use UiActionMenu. */
withDefaults(defineProps<{
  options: readonly SelectOption<T>[];
  label?: string;
  icon?: IconComponent;
  size?: "md" | "sm";
  disabled?: boolean;
}>(), { size: "md" });

const model = defineModel<T>({ required: true });
</script>

<template>
  <span :class="['ui-select', `ui-select--${size}`, { 'ui-select--with-icon': icon }]">
    <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" class="ui-select__icon" aria-hidden="true" />
    <select v-model="model" :aria-label="label" :disabled="disabled">
      <option v-for="option in options" :key="String(option.value)" :value="option.value">{{ option.label }}</option>
    </select>
    <ChevronDown :size="14" :stroke-width="1.75" class="ui-select__chevron" aria-hidden="true" />
  </span>
</template>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}

.ui-select select {
  width: 100%;
  height: var(--control-height);
  padding: 0 28px 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 500;
  appearance: none;
  color-scheme: dark;
  cursor: pointer;
  text-overflow: ellipsis;
}

.ui-select--sm select {
  height: var(--control-height-sm);
  font-size: var(--text-xs);
}

.ui-select--with-icon select {
  padding-left: 32px;
}

.ui-select select:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-muted-hover);
}

.ui-select select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.ui-select select:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ui-select option {
  background: var(--bg-subtle);
  color: var(--fg);
}

.ui-select__icon {
  position: absolute;
  left: 10px;
  color: var(--fg-muted);
  pointer-events: none;
}

.ui-select__chevron {
  position: absolute;
  right: 9px;
  color: var(--fg-muted);
  pointer-events: none;
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { iconProps, type IconComponent } from "./types";
import UiSpinner from "./UiSpinner.vue";

const props = withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "invisible" | "danger";
    size?: "md" | "sm";
    icon?: IconComponent;
    trailingIcon?: IconComponent;
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
    /** Renders a RouterLink styled as a button. */
    to?: RouteLocationRaw;
    /** Icon-only button: hides the label visually but keeps it for screen readers and the tooltip. */
    iconOnly?: boolean;
    label?: string;
  }>(),
  {
    variant: "default",
    size: "md",
    type: "button",
  },
);

const classes = computed(() => [
  "ui-button",
  `ui-button--${props.variant}`,
  `ui-button--${props.size}`,
  { "ui-button--icon-only": props.iconOnly },
]);
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="classes" :title="iconOnly ? label : undefined">
    <component :is="icon" v-if="icon" v-bind="iconProps" aria-hidden="true" />
    <span :class="{ 'sr-only': iconOnly }"
      ><slot>{{ label }}</slot></span
    >
    <component :is="trailingIcon" v-if="trailingIcon" v-bind="iconProps" aria-hidden="true" />
  </RouterLink>
  <button
    v-else
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :title="iconOnly ? label : undefined"
  >
    <UiSpinner v-if="loading" :size="14" />
    <component :is="icon" v-else-if="icon" v-bind="iconProps" aria-hidden="true" />
    <span :class="{ 'sr-only': iconOnly }"
      ><slot>{{ label }}</slot></span
    >
    <component :is="trailingIcon" v-if="trailingIcon" v-bind="iconProps" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  text-decoration: none;
  transition:
    background-color 0.12s,
    border-color 0.12s;
}

.ui-button:hover:not(:disabled) {
  background: var(--bg-muted-hover);
  border-color: var(--border-strong);
  text-decoration: none;
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ui-button :deep(.lucide) {
  color: var(--fg-muted);
}

.ui-button--sm {
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.ui-button--icon-only {
  width: var(--control-height);
  padding: 0;
}

.ui-button--sm.ui-button--icon-only {
  width: var(--control-height-sm);
}

.ui-button--primary {
  border-color: var(--border-on-emphasis);
  background: var(--success-emphasis);
  color: var(--fg-on-emphasis);
}

.ui-button--primary:hover:not(:disabled) {
  border-color: var(--border-on-emphasis);
  background: var(--success-emphasis-hover);
}

.ui-button--primary :deep(.lucide) {
  color: var(--fg-on-emphasis);
}

.ui-button--invisible {
  border-color: transparent;
  background: transparent;
  color: var(--fg-muted);
}

.ui-button--invisible:hover:not(:disabled) {
  border-color: transparent;
  background: var(--bg-hover);
  color: var(--fg);
}

.ui-button--danger {
  color: var(--danger);
}

.ui-button--danger :deep(.lucide) {
  color: var(--danger);
}

.ui-button--danger:hover:not(:disabled) {
  border-color: var(--danger-emphasis);
  background: var(--danger-emphasis);
  color: var(--fg-on-emphasis);
}

.ui-button--danger:hover:not(:disabled) :deep(.lucide) {
  color: var(--fg-on-emphasis);
}
</style>

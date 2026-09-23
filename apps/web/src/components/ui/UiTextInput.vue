<script setup lang="ts">
import { ref } from "vue";
import type { IconComponent } from "./types";

withDefaults(defineProps<{
  icon?: IconComponent;
  type?: "text" | "search" | "date";
  placeholder?: string;
  label?: string;
  size?: "md" | "sm";
  mono?: boolean;
  maxlength?: number;
  required?: boolean;
  autofocus?: boolean;
}>(), { type: "text", size: "md" });

const model = defineModel<string>({ default: "" });
const input = ref<HTMLInputElement | null>(null);

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <label :class="['ui-text-input', `ui-text-input--${size}`]">
    <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" class="ui-text-input__icon" aria-hidden="true" />
    <slot name="prefix" />
    <input
      ref="input"
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      :aria-label="label"
      :maxlength="maxlength"
      :required="required"
      :autofocus="autofocus"
      :class="{ mono }"
    />
    <slot name="suffix" />
  </label>
</template>

<style scoped>
.ui-text-input {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
  color: var(--fg-muted);
  cursor: text;
}

.ui-text-input--sm {
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
}

.ui-text-input:focus-within {
  border-color: var(--accent-emphasis);
  box-shadow: inset 0 0 0 1px var(--accent-emphasis);
}

.ui-text-input input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  background: none;
  color: var(--fg);
  font-size: var(--text-md);
  color-scheme: dark;
}

.ui-text-input input::placeholder {
  color: var(--fg-subtle);
}

.ui-text-input input.mono {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
</style>

<script setup lang="ts">
import { X } from "lucide-vue-next";
import UiIconButton from "./UiIconButton.vue";

/**
 * Title row for the `header` slot of UiSidePanel: an optional leading item, the title, the panel's
 * actions and a close button. The default slot holds what sits under the title (labels, notes).
 */
defineProps<{ title: string; closeLabel: string }>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="ui-side-panel-header">
    <div class="ui-side-panel-header__bar">
      <div v-if="$slots.leading" class="ui-side-panel-header__leading"><slot name="leading" /></div>
      <h2 class="ui-side-panel-header__title">{{ title }}</h2>
      <div class="ui-side-panel-header__actions">
        <slot name="actions" />
        <UiIconButton :icon="X" :label="closeLabel" @click="emit('close')" />
      </div>
    </div>
    <div v-if="$slots.default" class="ui-side-panel-header__body"><slot /></div>
  </div>
</template>

<style scoped>
/* When the panel is narrow the actions wrap onto their own row under the title (right aligned), so long titles never squeeze the buttons. */
.ui-side-panel-header__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.ui-side-panel-header__leading {
  flex: none;
}

.ui-side-panel-header__title {
  flex: 1 1 14rem;
  min-width: 0;
  color: var(--fg);
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.ui-side-panel-header__actions {
  display: flex;
  flex: none;
  gap: var(--space-1);
  margin-left: auto;
}

.ui-side-panel-header__body {
  margin-top: var(--space-2);
}
</style>

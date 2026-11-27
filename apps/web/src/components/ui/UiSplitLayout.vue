<script setup lang="ts">
import UiStack from "./UiStack.vue";

defineProps<{ asideLabel?: string }>();
</script>

<template>
  <div :class="['ui-split-layout', { 'ui-split-layout--single': !$slots.aside }]">
    <UiStack><slot name="main" /></UiStack>
    <UiStack v-if="$slots.aside" :tag="asideLabel ? 'aside' : 'div'" :aria-label="asideLabel">
      <slot name="aside" />
    </UiStack>
  </div>
</template>

<style scoped>
.ui-split-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  gap: var(--space-4);
  align-items: start;
}

.ui-split-layout--single {
  grid-template-columns: minmax(0, 1fr);
}

@media (max-width: 959px) {
  .ui-split-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

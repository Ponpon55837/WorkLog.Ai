<script setup lang="ts">
import UiStack from "./UiStack.vue";

/**
 * Main column plus a narrower side column. Each column is a UiStack, columns keep their own height
 * (`align-items: start`), and below 960px the side column stacks under the main one.
 * Without an `aside` slot the layout is a single column, so the main column keeps the full width.
 * `asideLabel` turns the side column into a labelled `aside` landmark.
 */
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

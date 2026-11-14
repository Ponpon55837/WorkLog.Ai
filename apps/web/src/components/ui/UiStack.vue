<script setup lang="ts">
/**
 * Vertical stack with one gap between children. UiBox adds a top margin to a Box that follows another Box;
 * here the gap does the spacing, so that margin is cancelled for direct Box children.
 */
withDefaults(defineProps<{ tag?: string }>(), { tag: "div" });
</script>

<template>
  <component :is="tag" class="ui-stack"><slot /></component>
</template>

<style scoped>
.ui-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.ui-stack > :deep(.ui-box + .ui-box) {
  margin-top: 0;
}
</style>

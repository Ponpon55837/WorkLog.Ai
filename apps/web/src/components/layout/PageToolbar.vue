<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/** Publishes its height as `--page-toolbar-height` so sticky UiBox headers stack under it. */
const toolbar = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;

function publishHeight(): void {
  const height = toolbar.value?.offsetHeight ?? 0;
  document.documentElement.style.setProperty("--page-toolbar-height", `${height}px`);
}

onMounted(() => {
  publishHeight();
  if (typeof ResizeObserver !== "undefined" && toolbar.value) {
    observer = new ResizeObserver(publishHeight);
    observer.observe(toolbar.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  document.documentElement.style.removeProperty("--page-toolbar-height");
});
</script>

<template>
  <div ref="toolbar" class="page-toolbar">
    <slot />
  </div>
</template>

<style scoped>
.page-toolbar {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding: var(--space-2) 0;
  background: var(--bg-canvas);
}

/* Tabs inside the toolbar own the full row and drop their standalone spacing. */
.page-toolbar :deep(.ui-underline-nav) {
  flex: 1 1 100%;
  margin-bottom: 0;
}

.page-toolbar:has(.ui-underline-nav) {
  padding: 0;
}
</style>

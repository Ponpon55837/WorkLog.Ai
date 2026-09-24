<script setup lang="ts">
/**
 * Bordered container. `stickyHeader` pins the header while the page scrolls, directly below the
 * page's sticky PageToolbar (offset `--page-toolbar-height`, set by PageToolbar).
 */
withDefaults(defineProps<{ padded?: boolean; tag?: string; stickyHeader?: boolean }>(), {
  padded: false,
  tag: "section",
  stickyHeader: false,
});
</script>

<template>
  <component :is="tag" class="ui-box">
    <header v-if="$slots.header" :class="['ui-box__header', { 'ui-box__header--sticky': stickyHeader }]">
      <slot name="header" />
    </header>
    <div :class="['ui-box__body', { 'ui-box__body--padded': padded }]">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="ui-box__footer">
      <slot name="footer" />
    </footer>
  </component>
</template>

<style scoped>
.ui-box {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-canvas);
  /* clip (not hidden) rounds the corners without creating a scroll container, so sticky headers still work. */
  overflow: clip;
  /* Keeps scrollIntoView targets clear of the sticky page toolbar. */
  scroll-margin-top: calc(var(--page-toolbar-height, 0px) + var(--space-2));
}

.ui-box + .ui-box {
  margin-top: var(--space-4);
}

.ui-box__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  min-height: 48px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}

.ui-box__header--sticky {
  position: sticky;
  top: var(--page-toolbar-height, 0px);
  z-index: 5;
}

.ui-box__body--padded {
  padding: var(--space-4);
}

.ui-box__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>

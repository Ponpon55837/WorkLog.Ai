<script setup lang="ts">
withDefaults(defineProps<{ padded?: boolean; tag?: string }>(), { padded: false, tag: "section" });
</script>

<template>
  <component :is="tag" class="ui-box">
    <header v-if="$slots.header" class="ui-box__header">
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
  overflow: hidden;
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

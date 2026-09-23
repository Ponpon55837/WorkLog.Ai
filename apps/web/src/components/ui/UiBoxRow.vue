<script setup lang="ts">
/**
 * One list row inside UiBox. When `clickable`, the title becomes a stretched button so the whole
 * row is a click target while trailing actions stay independently focusable (GitHub pattern).
 */
withDefaults(defineProps<{ clickable?: boolean; title?: string; meta?: string; tag?: string }>(), {
  clickable: false,
  tag: "div"
});

const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <component :is="tag" :class="['ui-box-row', { 'ui-box-row--clickable': clickable }]">
    <div v-if="$slots.leading" class="ui-box-row__leading"><slot name="leading" /></div>
    <div class="ui-box-row__main">
      <div class="ui-box-row__title">
        <button v-if="clickable" type="button" class="ui-box-row__link" @click="emit('select')">
          <slot name="title">{{ title }}</slot>
        </button>
        <span v-else class="ui-box-row__text"><slot name="title">{{ title }}</slot></span>
        <slot name="labels" />
      </div>
      <div v-if="meta || $slots.meta" class="ui-box-row__meta"><slot name="meta">{{ meta }}</slot></div>
      <slot />
    </div>
    <div v-if="$slots.trailing" class="ui-box-row__trailing"><slot name="trailing" /></div>
  </component>
</template>

<style scoped>
.ui-box-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.ui-box-row:first-child {
  border-top: 0;
}

.ui-box-row--clickable:hover {
  background: var(--bg-subtle);
}

.ui-box-row__leading {
  display: flex;
  padding-top: 2px;
  color: var(--fg-muted);
}

.ui-box-row__main {
  flex: 1;
  min-width: 0;
}

.ui-box-row__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.ui-box-row__link,
.ui-box-row__text {
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
  text-align: left;
  overflow-wrap: anywhere;
}

.ui-box-row__link::after {
  content: "";
  position: absolute;
  inset: 0;
}

.ui-box-row__link:focus-visible {
  outline: none;
}

.ui-box-row__link:focus-visible::after {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.ui-box-row--clickable:hover .ui-box-row__link {
  color: var(--accent);
}

.ui-box-row__meta {
  margin-top: 2px;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-box-row__trailing {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 639px) {
  .ui-box-row__trailing :deep(.hide-sm) {
    display: none;
  }
}
</style>

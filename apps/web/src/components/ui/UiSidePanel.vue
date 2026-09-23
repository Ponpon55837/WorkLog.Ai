<script setup lang="ts">
import { computed, ref, toRef } from "vue";
import { useFocusTrap } from "../../composables/useFocusTrap";

/**
 * Right-hand panel for reading a record. `modal` (default) adds a backdrop, traps focus and locks
 * scroll; `modal=false` docks beside the content so the page stays interactive (Graph node panel).
 */
const props = withDefaults(defineProps<{
  open: boolean;
  label: string;
  modal?: boolean;
  width?: number;
}>(), { modal: true, width: 640 });

const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);

useFocusTrap(panel, toRef(props, "open"), {
  onEscape: () => emit("close"),
  lockScroll: props.modal,
  trapTab: props.modal
});

const panelStyle = computed(() => ({ "--panel-width": `${props.width}px` }));
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-side-panel-fade">
      <div v-if="open && modal" class="ui-side-panel__backdrop" @click="emit('close')"></div>
    </Transition>
    <Transition name="ui-side-panel-slide">
      <aside
        v-if="open"
        ref="panel"
        :class="['ui-side-panel', { 'ui-side-panel--docked': !modal }]"
        :style="panelStyle"
        role="dialog"
        :aria-modal="modal ? 'true' : undefined"
        :aria-label="label"
        tabindex="-1"
      >
        <header v-if="$slots.header" class="ui-side-panel__header"><slot name="header" /></header>
        <div class="ui-side-panel__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-side-panel__footer"><slot name="footer" /></footer>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-side-panel__backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--bg-overlay);
}

.ui-side-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 41;
  display: flex;
  flex-direction: column;
  width: min(var(--panel-width), 100%);
  border-left: 1px solid var(--border);
  background: var(--bg-canvas);
  box-shadow: var(--shadow-panel);
  outline: none;
}

.ui-side-panel--docked {
  top: var(--header-height);
  z-index: 30;
}

.ui-side-panel__header {
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--border-muted);
}

.ui-side-panel__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-8);
  overflow-y: auto;
}

.ui-side-panel__footer {
  padding: var(--space-2) var(--space-6);
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-side-panel-fade-enter-active,
.ui-side-panel-fade-leave-active {
  transition: opacity 0.15s;
}

.ui-side-panel-fade-enter-from,
.ui-side-panel-fade-leave-to {
  opacity: 0;
}

.ui-side-panel-slide-enter-active,
.ui-side-panel-slide-leave-active {
  transition: transform 0.2s ease;
}

.ui-side-panel-slide-enter-from,
.ui-side-panel-slide-leave-to {
  transform: translateX(100%);
}

@media (max-width: 639px) {
  .ui-side-panel__header,
  .ui-side-panel__body,
  .ui-side-panel__footer {
    padding-right: var(--space-4);
    padding-left: var(--space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-side-panel-slide-enter-active,
  .ui-side-panel-slide-leave-active,
  .ui-side-panel-fade-enter-active,
  .ui-side-panel-fade-leave-active {
    transition: none;
  }
}
</style>

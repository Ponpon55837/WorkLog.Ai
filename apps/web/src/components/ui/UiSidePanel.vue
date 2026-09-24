<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import { useFocusTrap } from "../../composables/useFocusTrap";

/**
 * Right-hand panel for reading a record. `modal` (default) adds a backdrop, traps focus and locks
 * scroll; `modal=false` docks beside the content so the page stays interactive (Graph node panel).
 * The left edge can be dragged (or moved with the arrow keys) to resize; with `storageKey` the
 * chosen width is remembered per panel.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    label: string;
    modal?: boolean;
    width?: number;
    minWidth?: number;
    storageKey?: string;
  }>(),
  { modal: true, width: 640, minWidth: 360 },
);

const emit = defineEmits<{ close: []; resize: [width: number] }>();
const panel = ref<HTMLElement | null>(null);
const resizeStep = 32;
// Keep part of the page visible behind the panel even at the widest setting.
const viewportMargin = 160;

function storageId(): string | undefined {
  return props.storageKey ? `wi.side-panel-width.${props.storageKey}` : undefined;
}

function readStoredWidth(): number | undefined {
  const key = storageId();
  if (!key) {
    return undefined;
  }
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall back to the default.
    return undefined;
  }
}

function writeStoredWidth(value: number): void {
  const key = storageId();
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Remembering the width is a convenience only.
  }
}

function clampWidth(value: number): number {
  const maxWidth = Math.max(props.minWidth, window.innerWidth - viewportMargin);
  return Math.round(Math.min(Math.max(value, props.minWidth), maxWidth));
}

const currentWidth = ref(clampWidth(readStoredWidth() ?? props.width));
const resizing = ref(false);

function setWidth(value: number, persist: boolean): void {
  currentWidth.value = clampWidth(value);
  emit("resize", currentWidth.value);
  if (persist) {
    writeStoredWidth(currentWidth.value);
  }
}

function onPointerMove(event: PointerEvent): void {
  setWidth(window.innerWidth - event.clientX, false);
}

function stopResize(): void {
  if (!resizing.value) {
    return;
  }
  resizing.value = false;
  document.body.classList.remove("is-resizing-panel");
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopResize);
  writeStoredWidth(currentWidth.value);
}

function startResize(event: PointerEvent): void {
  event.preventDefault();
  resizing.value = true;
  document.body.classList.add("is-resizing-panel");
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopResize);
}

function onResizeKey(event: KeyboardEvent): void {
  const delta = { ArrowLeft: resizeStep, ArrowRight: -resizeStep }[event.key];
  if (delta) {
    event.preventDefault();
    setWidth(currentWidth.value + delta, true);
  } else if (event.key === "Home") {
    event.preventDefault();
    setWidth(props.width, true);
  }
}

useFocusTrap(panel, toRef(props, "open"), {
  onEscape: () => emit("close"),
  lockScroll: props.modal,
  trapTab: props.modal,
});

// Report the (possibly remembered) width whenever the panel opens so a docked layout can make room.
watch(
  () => props.open,
  (open) => {
    if (open) {
      setWidth(currentWidth.value, false);
    }
  },
  { immediate: true },
);

onBeforeUnmount(stopResize);

const panelStyle = computed(() => ({ "--panel-width": `${currentWidth.value}px` }));
const maxWidth = computed(() => clampWidth(Number.POSITIVE_INFINITY));
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
        :class="['ui-side-panel', { 'ui-side-panel--docked': !modal, 'is-resizing': resizing }]"
        :style="panelStyle"
        role="dialog"
        :aria-modal="modal ? 'true' : undefined"
        :aria-label="label"
        tabindex="-1"
      >
        <header v-if="$slots.header" class="ui-side-panel__header"><slot name="header" /></header>
        <div class="ui-side-panel__body"><slot /></div>
        <footer v-if="$slots.footer" class="ui-side-panel__footer"><slot name="footer" /></footer>
        <!-- Last in DOM order so the focus trap still lands on the panel content first. -->
        <div
          class="ui-side-panel__resize"
          role="separator"
          aria-orientation="vertical"
          :aria-label="`調整${label}寬度`"
          :aria-valuenow="currentWidth"
          :aria-valuemin="minWidth"
          :aria-valuemax="maxWidth"
          tabindex="0"
          title="拖曳調整寬度（方向鍵微調，Home 還原）"
          @pointerdown="startResize"
          @keydown="onResizeKey"
          @dblclick="setWidth(width, true)"
        ></div>
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

.ui-side-panel__resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  cursor: col-resize;
  outline: none;
  touch-action: none;
}

.ui-side-panel__resize::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
  content: "";
  transition: background 0.15s;
}

.ui-side-panel__resize:hover::after,
.ui-side-panel__resize:focus-visible::after,
.ui-side-panel.is-resizing .ui-side-panel__resize::after {
  background: var(--accent);
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

  /* The panel is full screen on phones, so there is nothing to resize. */
  .ui-side-panel__resize {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-side-panel-slide-enter-active,
  .ui-side-panel-slide-leave-active,
  .ui-side-panel-fade-enter-active,
  .ui-side-panel-fade-leave-active,
  .ui-side-panel__resize::after {
    transition: none;
  }
}
</style>

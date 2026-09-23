<script setup lang="ts">
import { ref, toRef } from "vue";
import { X } from "lucide-vue-next";
import { useFocusTrap } from "../../composables/useFocusTrap";

/** Centered dialog for forms and decisions. Footer actions are right-aligned, primary last. */
const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  /** Prevents closing (Escape, backdrop, close button) while a save is in flight. */
  busy?: boolean;
}>(), { size: "md", busy: false });

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);

function requestClose(): void {
  if (!props.busy) {
    emit("close");
  }
}

useFocusTrap(dialog, toRef(props, "open"), { onEscape: requestClose });
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-dialog">
      <div v-if="open" class="ui-dialog__backdrop" @click.self="requestClose">
        <section ref="dialog" :class="['ui-dialog', `ui-dialog--${size}`]" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
          <header class="ui-dialog__header">
            <div class="ui-dialog__heading">
              <h2>{{ title }}</h2>
              <p v-if="description">{{ description }}</p>
            </div>
            <button type="button" class="ui-dialog__close" aria-label="關閉對話框" :disabled="busy" @click="requestClose">
              <X :size="16" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </header>
          <div class="ui-dialog__body"><slot /></div>
          <footer v-if="$slots.footer" class="ui-dialog__footer"><slot name="footer" /></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-dialog__backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--bg-overlay);
}

.ui-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100vh - var(--space-8));
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  box-shadow: var(--shadow-popover);
  outline: none;
}

.ui-dialog--sm { max-width: 440px; }
.ui-dialog--md { max-width: 640px; }
.ui-dialog--lg { max-width: 880px; }

.ui-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.ui-dialog__heading h2 {
  color: var(--fg);
  font-size: var(--text-lg);
  font-weight: 600;
}

.ui-dialog__heading p {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.ui-dialog__close {
  display: inline-flex;
  padding: var(--space-1);
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
}

.ui-dialog__close:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.ui-dialog__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

.ui-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.ui-dialog-enter-active,
.ui-dialog-leave-active {
  transition: opacity 0.15s;
}

.ui-dialog-enter-from,
.ui-dialog-leave-to {
  opacity: 0;
}
</style>

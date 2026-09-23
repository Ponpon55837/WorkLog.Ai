<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";

const { toasts, dismissToast } = useToast();
const icons = { default: Info, success: CircleCheck, danger: CircleAlert } as const;
</script>

<template>
  <div class="ui-toast-host" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="ui-toast">
      <div v-for="toast in toasts" :key="toast.id" :class="['ui-toast', `ui-toast--${toast.tone}`]" role="status">
        <component :is="icons[toast.tone]" :size="16" :stroke-width="1.75" class="ui-toast__icon" aria-hidden="true" />
        <span class="ui-toast__message">{{ toast.message }}</span>
        <button type="button" class="ui-toast__close" aria-label="關閉通知" @click="dismissToast(toast.id)">
          <X :size="14" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.ui-toast-host {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 80;
  display: grid;
  gap: var(--space-2);
  width: min(400px, calc(100vw - var(--space-8)));
  pointer-events: none;
}

.ui-toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  box-shadow: var(--shadow-popover);
  color: var(--fg);
  font-size: var(--text-sm);
  pointer-events: auto;
}

.ui-toast__icon { margin-top: 2px; color: var(--accent); }
.ui-toast--success .ui-toast__icon { color: var(--success); }
.ui-toast--danger .ui-toast__icon { color: var(--danger); }
.ui-toast--danger { border-color: var(--danger-border); }

.ui-toast__message {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ui-toast__close {
  display: inline-flex;
  padding: 2px;
  border: 0;
  background: none;
  color: var(--fg-muted);
}

.ui-toast-enter-active,
.ui-toast-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}

.ui-toast-enter-from,
.ui-toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>

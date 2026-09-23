<script setup lang="ts">
import { ref } from "vue";
import UiConfirmHost from "../ui/UiConfirmHost.vue";
import UiToastHost from "../ui/UiToastHost.vue";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";

defineProps<{
  refreshing?: boolean;
  counts?: Partial<Record<string, { value: number; tone?: "default" | "attention" }>>;
  /** Removes the max-width content column (Graph canvas). */
  fullWidth?: boolean;
}>();
const emit = defineEmits<{ refresh: []; search: [] }>();
const menuOpen = ref(false);
</script>

<template>
  <div class="app-shell">
    <AppHeader :refreshing="refreshing" :menu-open="menuOpen" @refresh="emit('refresh')" @search="emit('search')" @toggle-menu="menuOpen = !menuOpen" />
    <div class="app-shell__body">
      <AppSidebar :open="menuOpen" :counts="counts" @close="menuOpen = false" />
      <main id="main" class="app-shell__main">
        <div :class="['app-shell__content', { 'app-shell__content--full': fullWidth }]">
          <slot />
        </div>
      </main>
    </div>
    <slot name="overlays" />
    <UiConfirmHost />
    <UiToastHost />
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-rows: var(--header-height) 1fr;
  height: 100vh;
  height: 100dvh;
}

.app-shell__body {
  display: flex;
  min-height: 0;
}

.app-shell__main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.app-shell__content {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: var(--space-6) var(--space-8) var(--space-16);
}

.app-shell__content--full {
  max-width: none;
}

@media (max-width: 959px) {
  .app-shell__content {
    padding: var(--space-6) var(--space-6) var(--space-12);
  }
}

@media (max-width: 639px) {
  .app-shell__content {
    padding: var(--space-4) var(--space-4) var(--space-12);
  }
}
</style>

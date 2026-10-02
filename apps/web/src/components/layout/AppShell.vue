<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import type { ApiHealth } from "../../api/client";
import UiConfirmHost from "../ui/UiConfirmHost.vue";
import UiToastHost from "../ui/UiToastHost.vue";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import { useNavigationProgress } from "../../composables/useNavigationProgress";
import { t } from "../../i18n";

defineProps<{
  refreshing?: boolean;
  appHealth?: ApiHealth | null;
  counts?: Partial<Record<string, { value: number; tone?: "default" | "attention" }>>;
  /** Removes the max-width content column (Graph canvas). */
  fullWidth?: boolean;
}>();
const emit = defineEmits<{ refresh: []; search: [] }>();

const route = useRoute();
const navigating = useNavigationProgress();

const menuOpen = ref(false);
const main = ref<HTMLElement | null>(null);

// <main> is the scroll container, so router scrollBehavior (window) cannot reset it. A path change
// (new page or tab) starts at the top; query-only changes (filters, pagination, ?session) keep position.
watch(
  () => route.path,
  () => main.value?.scrollTo({ top: 0 }),
);
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main">{{ t("跳至主要內容") }}</a>
    <!-- Indeterminate bar while a page loads or everything refreshes; it waits a moment so fast loads never flash it. -->
    <div v-if="navigating || refreshing" class="app-shell__progress" role="progressbar" :aria-label="t('載入中')">
      <span></span>
    </div>
    <AppHeader
      :refreshing="refreshing"
      :menu-open="menuOpen"
      @refresh="emit('refresh')"
      @search="emit('search')"
      @toggle-menu="menuOpen = !menuOpen"
    />
    <div class="app-shell__body">
      <AppSidebar :open="menuOpen" :counts="counts" :app-health="appHealth" @close="menuOpen = false" />
      <main id="main" ref="main" class="app-shell__main" tabindex="-1">
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
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: var(--header-height) minmax(0, 1fr);
  height: 100vh;
  height: 100dvh;
}

.app-shell__progress {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 90;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
  animation: wi-fade-in var(--duration-fast) var(--ease-out) 150ms both;
}

.app-shell__progress span {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--accent);
  animation: wi-progress 1.1s var(--ease-standard) infinite;
}

.app-shell__main:focus {
  outline: none;
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

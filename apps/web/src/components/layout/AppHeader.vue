<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { Languages, Menu, Moon, RefreshCw, Search, Sun } from "lucide-vue-next";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { usePreferencesStore } from "../../stores/preferences";
import { LOCALE_OPTIONS, t } from "../../i18n";

defineProps<{ refreshing?: boolean; menuOpen?: boolean }>();
const emit = defineEmits<{ refresh: []; search: []; toggleMenu: [] }>();

const route = useRoute();
const preferencesStore = usePreferencesStore();
const { locale, resolvedTheme, theme } = storeToRefs(preferencesStore);
const crumb = computed(() => (route.meta.title ? t(route.meta.title) : ""));
const localeLabel = computed(() => LOCALE_OPTIONS.find((option) => option.value === locale.value)?.label ?? "");
const themeToggleLabel = computed(() =>
  resolvedTheme.value === "dark" ? t("common.switchToLightTheme") : t("common.switchToDarkTheme"),
);
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
// Announced through aria-keyshortcuts so the visible kbd hint can stay out of the accessible name.
const searchShortcut = isMac ? "Meta+K" : "Control+K";
</script>

<template>
  <header class="app-header">
    <button
      class="app-header__menu"
      type="button"
      :aria-expanded="menuOpen"
      :aria-label="t('layout.openMainMenu')"
      @click="emit('toggleMenu')"
    >
      <Menu :size="16" :stroke-width="1.75" aria-hidden="true" />
    </button>
    <RouterLink :to="{ name: 'dashboard' }" class="app-header__logo"
      >WI<span class="sr-only"> {{ t("layout.workIntelligenceHome") }}</span></RouterLink
    >
    <div class="app-header__crumb">
      <span class="app-header__app">Work Intelligence</span>
      <span class="app-header__sep" aria-hidden="true">/</span>
      <span class="app-header__page">{{ crumb }}</span>
    </div>
    <button class="app-header__search" type="button" :aria-keyshortcuts="searchShortcut" @click="emit('search')">
      <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
      <span class="app-header__search-text">{{ t("layout.searchSessionsKnowledgeOrJump") }}</span>
      <span class="app-header__keys" aria-hidden="true"
        ><kbd>{{ isMac ? "⌘" : "Ctrl" }}</kbd
        ><kbd>K</kbd></span
      >
    </button>
    <span class="app-header__status" :title="t('layout.dataStaysInLocalSqlite')">
      <span class="app-header__dot" aria-hidden="true"></span>
      <span class="app-header__status-text">{{ t("layout.localFirst") }}</span>
    </span>
    <UiActionMenu
      v-model="locale"
      class="app-header__locale"
      :label="localeLabel"
      :header="t('common.language')"
      :items="LOCALE_OPTIONS"
      :icon="Languages"
      align="end"
      variant="button"
      hide-label-on-mobile
    />
    <!-- An explicit choice overrides the system setting; System status → 個人偏好 can return to it. -->
    <UiIconButton
      class="app-header__theme"
      :icon="resolvedTheme === 'dark' ? Sun : Moon"
      :label="themeToggleLabel"
      @click="theme = resolvedTheme === 'dark' ? 'light' : 'dark'"
    />
    <UiIconButton :icon="RefreshCw" :label="t('common.refresh')" :loading="refreshing" @click="emit('refresh')" />
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--header-height);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--bg-canvas);
}

.app-header__menu {
  display: none;
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
}

.app-header__logo {
  position: relative; /* containing block for the visually hidden name suffix */
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius);
  background: var(--fg);
  color: var(--bg-canvas);
  font: 600 var(--text-xs) var(--font-mono);
  letter-spacing: 0.02em;
  text-decoration: none;
  transition: opacity var(--duration-instant) ease-out;
}

.app-header__logo:hover {
  opacity: 0.85;
  text-decoration: none;
}

.app-header__crumb {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  white-space: nowrap;
}

.app-header__app {
  color: var(--fg-muted);
}

.app-header__sep {
  color: var(--fg-subtle);
}

.app-header__page {
  overflow: hidden;
  color: var(--fg);
  font-weight: 500;
  text-overflow: ellipsis;
}

.app-header__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 340px;
  height: var(--control-height);
  margin-left: auto;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-surface);
  color: var(--fg-muted);
  font-size: var(--text-md);
  transition: border-color var(--duration-instant) ease-out;
}

.app-header__search:hover {
  border-color: var(--border-strong);
}

.app-header__search-text {
  flex: 1;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-header__keys {
  display: inline-flex;
  gap: var(--space-1);
}

.app-header__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.app-header__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}

/* The sun/moon swap turns in, so the switch reads as the same control changing state. */
.app-header__theme :deep(.lucide) {
  animation: app-header-theme-in var(--duration-slow) var(--ease-out);
}

@keyframes app-header-theme-in {
  from {
    opacity: 0;
    transform: rotate(-90deg) scale(0.6);
  }
}

@media (max-width: 959px) {
  .app-header__search {
    width: 220px;
  }

  .app-header__app,
  .app-header__sep {
    display: none;
  }
}

@media (max-width: 639px) {
  .app-header {
    gap: var(--space-2);
    padding: 0 var(--space-3);
  }

  .app-header__menu {
    display: inline-flex;
  }

  .app-header__search {
    position: relative;
    justify-content: center;
    width: var(--control-height);
    padding: 0;
  }

  /* The text is the button's accessible name, so hide it visually (same declarations as the global .sr-only) instead of display:none. */
  .app-header__search-text {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .app-header__keys,
  .app-header__status {
    display: none;
  }
}
</style>

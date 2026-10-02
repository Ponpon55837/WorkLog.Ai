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
    <RouterLink :to="{ name: 'dashboard' }" class="app-header__logo" :aria-label="t('layout.workIntelligenceHome')"
      >WI</RouterLink
    >
    <div class="app-header__crumb">
      <span class="app-header__app">Work Intelligence</span>
      <span class="app-header__sep" aria-hidden="true">/</span>
      <span class="app-header__page">{{ crumb }}</span>
    </div>
    <button class="app-header__search" type="button" :aria-label="t('common.searchOrJumpToA')" @click="emit('search')">
      <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
      <span class="app-header__search-text">{{ t("layout.searchSessionsKnowledgeOrJump") }}</span>
      <kbd>{{ isMac ? "⌘" : "Ctrl" }} K</kbd>
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
      size="sm"
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
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
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
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg);
  font: 700 11px var(--font-mono);
  letter-spacing: 0.04em;
  text-decoration: none;
}

.app-header__logo:hover {
  border-color: var(--border-strong);
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
  font-weight: 600;
}

.app-header__sep {
  color: var(--fg-subtle);
}

.app-header__page {
  overflow: hidden;
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
  background: var(--bg-canvas);
  color: var(--fg-muted);
  font-size: var(--text-sm);
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

kbd {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--fg-muted);
  font-size: 11px;
  white-space: nowrap;
}

.app-header__status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.app-header__dot {
  width: 8px;
  height: 8px;
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
    justify-content: center;
    width: var(--control-height);
    padding: 0;
  }

  .app-header__search-text,
  .app-header__search kbd,
  .app-header__status {
    display: none;
  }
}
</style>

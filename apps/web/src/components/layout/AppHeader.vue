<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Menu, RefreshCw, Search } from "lucide-vue-next";
import UiIconButton from "../ui/UiIconButton.vue";

defineProps<{ refreshing?: boolean; menuOpen?: boolean }>();
const emit = defineEmits<{ refresh: []; search: []; toggleMenu: [] }>();

const route = useRoute();
const crumb = computed(() => route.meta.title ?? "");
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<template>
  <header class="app-header">
    <button
      class="app-header__menu"
      type="button"
      :aria-expanded="menuOpen"
      aria-label="開啟主選單"
      @click="emit('toggleMenu')"
    >
      <Menu :size="16" :stroke-width="1.75" aria-hidden="true" />
    </button>
    <RouterLink :to="{ name: 'dashboard' }" class="app-header__logo" aria-label="Work Intelligence 首頁">WI</RouterLink>
    <div class="app-header__crumb">
      <span class="app-header__app">Work Intelligence</span>
      <span class="app-header__sep" aria-hidden="true">/</span>
      <span class="app-header__page">{{ crumb }}</span>
    </div>
    <button class="app-header__search" type="button" aria-label="搜尋或跳至頁面" @click="emit('search')">
      <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
      <span class="app-header__search-text">搜尋 Session、Knowledge 或跳至頁面…</span>
      <kbd>{{ isMac ? "⌘" : "Ctrl" }} K</kbd>
    </button>
    <span class="app-header__status" title="資料只存在本機 SQLite">
      <span class="app-header__dot" aria-hidden="true"></span>
      <span class="app-header__status-text">Local-first</span>
    </span>
    <UiIconButton :icon="RefreshCw" label="重新整理" :loading="refreshing" @click="emit('refresh')" />
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
  .app-header__status-text {
    display: none;
  }
}
</style>

<script setup lang="ts">
import { ShieldCheck } from "lucide-vue-next";
import type { ApiHealth } from "../../api/client";
import UiCounter from "../ui/UiCounter.vue";
import { navGroups, navItems } from "./navigation";
import { t } from "../../i18n";

/** Grouped primary navigation. Full width ≥ 960px, icon rail 640–959px, drawer below 640px. */
withDefaults(
  defineProps<{
    open?: boolean;
    counts?: Partial<Record<string, { value: number; tone?: "default" | "attention" }>>;
    appHealth?: ApiHealth | null;
  }>(),
  {
    open: false,
    counts: () => ({}),
  },
);
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div v-if="open" class="app-sidebar__scrim" @click="emit('close')"></div>
  <aside :class="['app-sidebar', { 'is-open': open }]">
    <nav :aria-label="t('layout.mainMenu')">
      <div v-for="group in navGroups" :key="group.id" class="app-sidebar__group">
        <div class="app-sidebar__group-label">{{ group.label }}</div>
        <RouterLink
          v-for="item in navItems.filter((candidate) => candidate.group === group.id)"
          :key="item.name"
          :to="{ name: item.name }"
          :data-testid="`nav-${item.name}`"
          :title="item.label"
          class="app-sidebar__item"
          active-class="is-active"
          @click="emit('close')"
        >
          <component :is="item.icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="app-sidebar__label">{{ item.label }}</span>
          <UiCounter
            v-if="counts[item.name]?.value"
            class="app-sidebar__counter"
            :count="counts[item.name]!.value"
            :tone="counts[item.name]!.tone"
          />
        </RouterLink>
      </div>
    </nav>
    <div class="app-sidebar__policy" :title="t('layout.everyHandoffGitOrSource')">
      <ShieldCheck :size="16" :stroke-width="1.75" aria-hidden="true" />
      <div class="app-sidebar__policy-copy">
        <strong>{{ t("layout.policyGateEnabled") }}</strong>
        <span>{{ t("layout.projectsYouHaveNotExplicitly") }}</span>
      </div>
    </div>
    <div v-if="appHealth" class="app-sidebar__app-info" :aria-label="t('layout.workIntelligenceVersionInformation')">
      <span data-testid="app-version">v{{ appHealth.version }}</span>
      <span data-testid="schema-version">Schema v{{ appHealth.schemaVersion }}</span>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  padding: var(--space-4) var(--space-2);
  border-right: 1px solid var(--border);
  background: var(--bg-canvas);
  overflow-y: auto;
}

.app-sidebar__group {
  margin-bottom: var(--space-4);
}

.app-sidebar__group-label {
  padding: 0 var(--space-2) var(--space-1);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 500;
}

.app-sidebar__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font-size: var(--text-md);
  text-decoration: none;
}

.app-sidebar__item :deep(.lucide) {
  color: var(--fg-subtle);
}

.app-sidebar__item {
  transition:
    background-color var(--duration-instant) ease-out,
    color var(--duration-instant) ease-out;
}

.app-sidebar__item:hover {
  background: var(--bg-hover);
  color: var(--fg);
  text-decoration: none;
}

/* The current page: a recessed fill, primary text colour and a heavier weight (no side bar). */
.app-sidebar__item.is-active {
  background: var(--bg-muted);
  color: var(--fg);
  font-weight: 500;
}

.app-sidebar__item.is-active :deep(.lucide) {
  color: var(--fg);
}

.app-sidebar__item :deep(.lucide) {
  transition:
    color var(--duration-instant) ease-out,
    transform var(--duration-fast) var(--ease-out);
}

.app-sidebar__item:hover :deep(.lucide) {
  color: var(--fg);
  transform: translateX(1px);
}

/* The count is small trailing text, not a pill. */
.app-sidebar__counter {
  min-width: 0;
  margin-left: auto;
  padding: 0;
  background: transparent;
  color: var(--fg-subtle);
  font-weight: 400;
  line-height: inherit;
}

.app-sidebar__counter.ui-counter--attention {
  background: transparent;
  color: var(--attention);
  font-weight: 500;
}

.app-sidebar__item.is-active .app-sidebar__counter {
  color: var(--fg-muted);
}

.app-sidebar__policy {
  display: flex;
  gap: var(--space-2);
  margin-top: auto;
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.app-sidebar__policy :deep(.lucide) {
  margin-top: 2px;
  color: var(--success);
}

.app-sidebar__policy-copy {
  display: grid;
  gap: 2px;
}

.app-sidebar__policy strong {
  color: var(--fg);
  font-weight: 600;
}

.app-sidebar__app-info {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.app-sidebar__scrim {
  display: none;
}

@media (min-width: 640px) and (max-width: 959px) {
  .app-sidebar {
    width: var(--sidebar-rail-width);
    align-items: center;
  }

  /* The label is the link's accessible name, so the rail hides it visually (same declarations as the global .sr-only) instead of display:none. */
  .app-sidebar__label {
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

  .app-sidebar__group-label,
  .app-sidebar__counter,
  .app-sidebar__policy-copy,
  .app-sidebar__app-info {
    display: none;
  }

  .app-sidebar__item {
    justify-content: center;
    width: 40px;
    padding: 0;
  }

  .app-sidebar__policy {
    justify-content: center;
    padding: var(--space-2);
  }
}

@media (max-width: 639px) {
  .app-sidebar {
    position: fixed;
    top: var(--header-height);
    bottom: 0;
    left: 0;
    z-index: 35;
    width: min(280px, 85vw);
    transform: translateX(-100%);
    transition: transform var(--duration-base) var(--ease-out);
  }

  .app-sidebar.is-open {
    transform: none;
  }

  .app-sidebar__scrim {
    position: fixed;
    inset: var(--header-height) 0 0;
    z-index: 34;
    display: block;
    background: var(--bg-overlay);
    animation: wi-fade-in var(--duration-base) var(--ease-out);
  }
}
</style>

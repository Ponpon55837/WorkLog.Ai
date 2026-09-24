<script setup lang="ts">
import { ShieldCheck } from "lucide-vue-next";
import UiCounter from "../ui/UiCounter.vue";
import { navGroups, navItems } from "./navigation";

/** Grouped primary navigation. Full width ≥ 960px, icon rail 640–959px, drawer below 640px. */
withDefaults(
  defineProps<{
    open?: boolean;
    counts?: Partial<Record<string, { value: number; tone?: "default" | "attention" }>>;
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
    <nav aria-label="主選單">
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
    <div class="app-sidebar__policy" title="任何 handoff、Git 或 source 讀取，都必須先通過 project policy gate。">
      <ShieldCheck :size="16" :stroke-width="1.75" aria-hidden="true" />
      <div class="app-sidebar__policy-copy">
        <strong>Policy gate enabled</strong>
        <span>未明確加入的專案，不讀取、不保存。</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  padding: var(--space-4) var(--space-2);
  border-right: 1px solid var(--border-muted);
  background: var(--bg-inset);
  overflow-y: auto;
}

.app-sidebar__group {
  margin-bottom: var(--space-4);
}

.app-sidebar__group-label {
  padding: 0 var(--space-2) 6px;
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app-sidebar__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--radius);
  color: var(--fg);
  font-size: var(--text-md);
  text-decoration: none;
}

.app-sidebar__item :deep(.lucide) {
  color: var(--fg-muted);
}

.app-sidebar__item:hover {
  background: var(--bg-hover);
  text-decoration: none;
}

.app-sidebar__item.is-active {
  background: var(--bg-muted);
  font-weight: 600;
}

.app-sidebar__item.is-active :deep(.lucide) {
  color: var(--fg);
}

.app-sidebar__item.is-active::before {
  content: "";
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: calc(-1 * var(--space-2));
  width: 4px;
  border-radius: var(--radius);
  background: var(--accent);
}

.app-sidebar__counter {
  margin-left: auto;
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

.app-sidebar__scrim {
  display: none;
}

@media (min-width: 640px) and (max-width: 959px) {
  .app-sidebar {
    width: var(--sidebar-rail-width);
    align-items: center;
  }

  .app-sidebar__group-label,
  .app-sidebar__label,
  .app-sidebar__counter,
  .app-sidebar__policy-copy {
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
    transition: transform 0.2s ease;
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
  }
}
</style>

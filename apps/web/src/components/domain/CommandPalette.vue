<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { BookOpen, CornerDownLeft, ListChecks, Search } from "lucide-vue-next";
import type { KnowledgeRecord, WorkSessionRecord } from "@work-intelligence/core";
import { navItems } from "../layout/navigation";
import type { IconComponent } from "../ui/types";
import { runKeyed, useApi } from "../../composables/useApi";
import { useFocusTrap } from "../../composables/useFocusTrap";
import { useSessionDetail } from "../../composables/useSessionDetail";
import { router } from "../../router";
import { formatRelative } from "../../utils/format";

type PaletteItem = { id: string; group: string; label: string; hint?: string; icon: IconComponent; run: () => void };

/** Ctrl/⌘ K palette: jump to pages and search Sessions and Knowledge through existing APIs. */
const open = defineModel<boolean>("open", { required: true });

const query = ref("");
const active = ref(0);
const sessions = ref<WorkSessionRecord[]>([]);
const knowledge = ref<KnowledgeRecord[]>([]);
const dialog = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
let timer: number | undefined;

useFocusTrap(dialog, open, { onEscape: () => (open.value = false) });

function close(): void {
  open.value = false;
}

const items = computed<PaletteItem[]>(() => {
  const term = query.value.trim().toLowerCase();
  const pages = navItems
    .filter((item) => !term || item.label.toLowerCase().includes(term) || item.name.includes(term))
    .map((item) => ({
      id: `page-${item.name}`,
      group: "頁面",
      label: item.label,
      hint: item.shortcut,
      icon: item.icon,
      run: () => void router.push({ name: item.name }),
    }));
  const sessionItems = sessions.value.map((session) => ({
    id: `session-${session.id}`,
    group: "Sessions",
    label: session.title,
    hint: `${session.projectName ?? ""} · ${formatRelative(session.completedAt)}`,
    icon: ListChecks,
    run: () => void useSessionDetail().openSessionDetail(session.id),
  }));
  const knowledgeItems = knowledge.value.map((item) => ({
    id: `knowledge-${item.id}`,
    group: "Knowledge",
    label: item.title,
    hint: item.projectName,
    icon: BookOpen,
    run: () => void router.push({ name: "knowledge", query: { q: item.title } }),
  }));
  return [...pages, ...sessionItems, ...knowledgeItems];
});

function isGroupStart(index: number): boolean {
  return index === 0 || items.value[index - 1]?.group !== items.value[index]?.group;
}

function choose(item: PaletteItem | undefined): void {
  if (!item) {
    return;
  }
  close();
  item.run();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    active.value = Math.min(active.value + 1, items.value.length - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    active.value = Math.max(active.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    choose(items.value[active.value]);
  }
}

async function search(term: string): Promise<void> {
  if (term.length < 2) {
    sessions.value = [];
    knowledge.value = [];
    return;
  }
  const client = useApi().client;
  await Promise.all([
    runKeyed(
      "palette-sessions",
      async (signal) => {
        sessions.value = (await client.listSessions({ q: term, pageSize: 5 }, signal)).items;
      },
      { onError: () => (sessions.value = []) },
    ),
    runKeyed(
      "palette-knowledge",
      async (signal) => {
        const result = await client.searchKnowledge({ q: term, pageSize: 5 }, signal);
        knowledge.value = result.outcome === "knowledge" ? result.items : [];
      },
      { onError: () => (knowledge.value = []) },
    ),
  ]);
}

watch(query, (term) => {
  active.value = 0;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void search(term.trim()), 200);
});

watch(open, async (value) => {
  if (value) {
    query.value = "";
    sessions.value = [];
    knowledge.value = [];
    active.value = 0;
    await nextTick();
    input.value?.focus();
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette__backdrop" @click.self="close">
      <div ref="dialog" class="palette" role="dialog" aria-modal="true" aria-label="搜尋或跳至頁面">
        <label class="palette__search">
          <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            type="text"
            placeholder="搜尋 Session、Knowledge 或頁面…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            :aria-activedescendant="items[active] ? `palette-${items[active]!.id}` : undefined"
            @keydown="onKeydown"
          />
        </label>
        <ul id="palette-results" class="palette__results" role="listbox">
          <template v-for="(item, index) in items" :key="item.id">
            <li v-if="isGroupStart(index)" class="palette__group" role="presentation">{{ item.group }}</li>
            <li
              :id="`palette-${item.id}`"
              role="option"
              :aria-selected="index === active"
              :class="['palette__item', { 'is-active': index === active }]"
              @mousemove="active = index"
              @click="choose(item)"
            >
              <component :is="item.icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
              <span class="palette__label">{{ item.label }}</span>
              <span v-if="item.hint" class="palette__hint">{{ item.hint }}</span>
              <CornerDownLeft
                v-if="index === active"
                :size="14"
                :stroke-width="1.75"
                class="palette__enter"
                aria-hidden="true"
              />
            </li>
          </template>
          <li v-if="items.length === 0" class="palette__empty">找不到符合的項目</li>
        </ul>
        <div class="palette__footer"><kbd>↑</kbd><kbd>↓</kbd> 選擇 · <kbd>Enter</kbd> 開啟 · <kbd>Esc</kbd> 關閉</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette__backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: center;
  padding: 12vh var(--space-4) var(--space-4);
  background: var(--bg-overlay);
}

.palette {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: 70vh;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  box-shadow: var(--shadow-popover);
}

.palette__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
}

.palette__search input {
  flex: 1;
  height: 48px;
  border: 0;
  outline: 0;
  background: none;
  color: var(--fg);
  font-size: var(--text-lg);
}

.palette__results {
  flex: 1;
  margin: 0;
  padding: var(--space-2);
  overflow-y: auto;
  list-style: none;
}

.palette__group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.palette__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius);
  color: var(--fg);
  cursor: pointer;
}

.palette__item :deep(.lucide) {
  color: var(--fg-muted);
}

.palette__item.is-active {
  background: var(--bg-hover);
}

.palette__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette__hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette__enter {
  margin-left: auto;
}

.palette__empty {
  padding: var(--space-6);
  color: var(--fg-muted);
  text-align: center;
}

.palette__footer {
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

kbd {
  margin-right: 2px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-size: 11px;
}
</style>

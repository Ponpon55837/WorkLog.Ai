<script setup lang="ts">
import { computed, ref } from "vue";
import { Archive, ArchiveRestore, ExternalLink, History, Pencil } from "lucide-vue-next";
import type { KnowledgeRecord } from "@work-intelligence/core";
import { formatDate, formatRelative } from "../../utils/format";
import { knowledgeKindVisual, knowledgeStatusVisual } from "../../utils/status";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiLabel from "../ui/UiLabel.vue";
import StatusLabel from "./StatusLabel.vue";

type KnowledgeAction = "edit" | "history" | "toggle-status" | "source";

const props = defineProps<{ item: KnowledgeRecord }>();
const emit = defineEmits<{ action: [action: KnowledgeAction, item: KnowledgeRecord] }>();

const expanded = ref(false);
const kind = computed(() => knowledgeKindVisual[props.item.kind]);
const actions = computed(() => [
  { value: "edit" as const, label: "編輯", icon: Pencil },
  { value: "history" as const, label: "變更紀錄", icon: History },
  ...(props.item.sessionId ? [{ value: "source" as const, label: "查看來源 Session", icon: ExternalLink }] : []),
  props.item.status === "active"
    ? { value: "toggle-status" as const, label: "封存", icon: Archive }
    : { value: "toggle-status" as const, label: "恢復使用", icon: ArchiveRestore }
]);
</script>

<template>
  <UiBoxRow tag="article" data-testid="knowledge-row">
    <template #leading>
      <component :is="kind.icon" :size="16" :stroke-width="1.75" :class="`tone-${kind.tone}`" aria-hidden="true" />
    </template>
    <template #title>{{ item.title }}</template>
    <template #labels>
      <StatusLabel :status="kind" :show-icon="false" />
      <StatusLabel v-if="item.status !== 'active'" :status="knowledgeStatusVisual[item.status]" />
    </template>
    <template #meta>
      <span v-if="item.projectName">{{ item.projectName }} · </span>
      <time :datetime="item.updatedAt" :title="formatDate(item.updatedAt)">更新於 {{ formatRelative(item.updatedAt) }}</time>
    </template>
    <p :class="['knowledge-row__body', { 'is-expanded': expanded }]">{{ item.body }}</p>
    <button v-if="item.body.length > 180" type="button" class="knowledge-row__more" @click="expanded = !expanded">{{ expanded ? "收合" : "展開全文" }}</button>
    <div v-if="item.tags.length || item.references.length" class="knowledge-row__chips">
      <UiLabel v-for="tag in item.tags" :key="`tag-${tag}`">#{{ tag }}</UiLabel>
      <code v-for="reference in item.references" :key="`ref-${reference}`" class="knowledge-row__ref">{{ reference }}</code>
    </div>
    <template #trailing>
      <UiActionMenu label="更多" hide-label-on-mobile variant="button" size="sm" align="end" :items="actions" @select="emit('action', $event, item)" />
    </template>
  </UiBoxRow>
</template>

<style scoped>
.knowledge-row__body {
  display: -webkit-box;
  margin-top: var(--space-2);
  overflow: hidden;
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.knowledge-row__body.is-expanded {
  display: block;
}

.knowledge-row__more {
  margin-top: var(--space-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: var(--text-xs);
}

.knowledge-row__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  margin-top: var(--space-2);
}

.knowledge-row__ref {
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.tone-accent { color: var(--accent); }
.tone-done { color: var(--done); }
.tone-attention { color: var(--attention); }
.tone-success { color: var(--success); }
.tone-neutral { color: var(--fg-muted); }
</style>

<script setup lang="ts">
import type { ProjectDeletionAuditRecord, ProjectDeletionCounts } from "@work-intelligence/core";
import { History, RefreshCw } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { formatDate, formatRelative } from "../../utils/format";
import { projectDeletionCountLabels } from "../../utils/labels";

defineProps<{
  items: ProjectDeletionAuditRecord[];
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{ retry: [] }>();

function countEntries(
  counts: ProjectDeletionCounts,
): Array<{ key: keyof ProjectDeletionCounts; label: string; count: number }> {
  return (Object.keys(projectDeletionCountLabels) as Array<keyof ProjectDeletionCounts>).map((key) => ({
    key,
    label: projectDeletionCountLabels[key],
    count: counts[key],
  }));
}
</script>

<template>
  <UiBox sticky-header data-testid="project-deletion-audit">
    <template #header>
      <UiBoxTitle eyebrow="PROJECT DELETION AUDIT" title="已刪除專案紀錄" :icon="History" :count="items.length" />
      <span class="project-deletion-audit__note">只保留時間、專案 id 與各類刪除筆數，不含名稱、路徑或工作內容</span>
    </template>

    <UiFlash v-if="error" tone="danger" title="無法載入刪除紀錄">
      {{ error }}
      <template #actions>
        <UiButton size="sm" :icon="RefreshCw" @click="emit('retry')">重試</UiButton>
      </template>
    </UiFlash>
    <UiSkeleton v-if="loading && items.length === 0" variant="row" :count="2" />
    <UiEmptyState
      v-else-if="items.length === 0 && !error"
      compact
      :icon="History"
      title="尚無刪除紀錄"
      description="永久刪除專案後，時間、專案 id 與刪除筆數會顯示在這裡。"
    />
    <UiBoxRow v-for="item in items" :key="`${item.projectId}-${item.deletedAt}`">
      <template #title
        ><code>{{ item.projectId }}</code></template
      >
      <template #meta>
        <time :datetime="item.deletedAt" :title="item.deletedAt">
          {{ formatDate(item.deletedAt) }} · {{ formatRelative(item.deletedAt) }}
        </time>
      </template>
      <dl class="project-deletion-audit__counts">
        <div v-for="entry in countEntries(item.deletedCounts)" :key="entry.key" class="project-deletion-audit__count">
          <dt>{{ entry.label }}</dt>
          <dd>{{ entry.count }}</dd>
        </div>
      </dl>
    </UiBoxRow>
  </UiBox>
</template>

<style scoped>
.project-deletion-audit__note {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.project-deletion-audit__counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-3);
}

.project-deletion-audit__count {
  min-width: 0;
}

.project-deletion-audit__count dt {
  overflow-wrap: anywhere;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.project-deletion-audit__count dd {
  color: var(--fg);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 959px) {
  .project-deletion-audit__counts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .project-deletion-audit__counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

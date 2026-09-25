<script setup lang="ts">
import { computed } from "vue";
import type { ChangedFileChangeStatus, WorkSessionRecord } from "@work-intelligence/core";
import { changedFileChangeStatusLabels, changedFileSourceLabels } from "../../utils/labels";
import VirtualList from "../VirtualList.vue";

/** Changed files with lifecycle badge and provenance. Changed files never imply a Git commit. */
const props = defineProps<{ session: WorkSessionRecord }>();

const statusLetter: Record<ChangedFileChangeStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

const rows = computed(() => {
  const changes = new Map(props.session.changedFileChanges.map((change) => [change.path, change]));
  const renamedFrom = new Set(
    props.session.changedFileChanges.flatMap((change) => (change.previousPath ? [change.previousPath] : [])),
  );
  return props.session.changedFiles
    .filter((path) => !renamedFrom.has(path))
    .map((path) => {
      const change = changes.get(path);
      const provenance = props.session.changedFilesProvenance.find((item) => item.path === path);
      return {
        path,
        status: change?.status,
        previousPath: change?.previousPath,
        sources: provenance?.sources.map((source) => changedFileSourceLabels[source]).join(" · ") || "未提供來源",
      };
    });
});
</script>

<template>
  <div class="changed-files">
    <VirtualList
      :items="rows"
      :enabled="rows.length > 5"
      :estimate-item-height="40"
      max-height="min(40vh, 400px)"
      label="Session changed files 清單"
    >
      <template #default="{ item: row }">
        <div class="changed-files__row">
          <span
            :class="['changed-files__badge', row.status && `is-${row.status}`]"
            :title="row.status ? changedFileChangeStatusLabels[row.status] : '未提供變更類型'"
            >{{ row.status ? statusLetter[row.status] : "·" }}</span
          >
          <code class="changed-files__path"
            >{{ row.path
            }}<span v-if="row.previousPath" class="changed-files__prev"> ← {{ row.previousPath }}</span></code
          >
          <span class="changed-files__source">{{ row.sources }}</span>
        </div>
      </template>
    </VirtualList>
    <p v-if="!rows.length" class="changed-files__empty">尚未提供檔案 metadata</p>
    <p class="changed-files__note">changed files 不代表 Git commit</p>
  </div>
</template>

<style scoped>
.changed-files__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  border-top: 1px solid var(--border-muted);
}

.changed-files__row:first-child {
  border-top: 0;
}

.changed-files__badge {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--fg-muted);
  font-size: 10px;
  font-weight: 700;
}

.changed-files__badge.is-added {
  border-color: var(--success);
  color: var(--success);
}
.changed-files__badge.is-modified {
  border-color: var(--attention);
  color: var(--attention);
}
.changed-files__badge.is-deleted {
  border-color: var(--danger);
  color: var(--danger);
}
.changed-files__badge.is-renamed {
  border-color: var(--done);
  color: var(--done);
}

.changed-files__path {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.changed-files__prev {
  color: var(--fg-muted);
}

.changed-files__source,
.changed-files__empty,
.changed-files__note {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.changed-files__source {
  flex: 0 0 auto;
  text-align: right;
}

.changed-files__empty,
.changed-files__note {
  padding: 6px var(--space-3);
}

.changed-files__note {
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
}
</style>

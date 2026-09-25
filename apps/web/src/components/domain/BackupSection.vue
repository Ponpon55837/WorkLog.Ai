<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Archive, DatabaseBackup, Download, RefreshCw } from "lucide-vue-next";
import type { ProjectDataImportPreview } from "@work-intelligence/core";
import { useBackups } from "../../composables/useBackups";
import { useProjectDataTransfer } from "../../composables/useProjectDataTransfer";
import { useProjects } from "../../composables/useProjects";
import { formatBytes, formatDate, formatRelative } from "../../utils/format";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCopyButton from "../ui/UiCopyButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import VirtualList from "../VirtualList.vue";

/**
 * Database backups and the whole-database export for moving to another computer. Restoring replaces
 * the database while nothing may hold it open, so it is a terminal command, not a button here.
 */
const {
  backups,
  backupKeep,
  automaticBackupKeep,
  backupsLoading,
  backupsError,
  backupCreating,
  databaseExporting,
  loadBackups,
  createBackup,
  exportDatabase,
} = useBackups();
const { projects, loadProjects } = useProjects();
const {
  transferError,
  portableExporting,
  importProjects,
  importFileName,
  importProjectId,
  importRemapFrom,
  importRemapTo,
  importLoading,
  importPreview,
  importError,
  loadImportFile,
  previewProjectDataImport,
  applyProjectDataImport,
  exportProjectData,
} = useProjectDataTransfer();

const scrollAfter = 6;
const restoreCommand = "pnpm db:restore <匯出的檔案> --remap-root <舊電腦的專案上層路徑>=<新電腦的路徑>";
const exportScope = ref<"all" | "project">("all");
const exportProjectId = ref("");
const exportScopeOptions = [
  { value: "all", label: "全部專案" },
  { value: "project", label: "單一專案" },
];
const exportProjectOptions = computed(() =>
  projects.value.map((project) => ({ value: project.id, label: project.name })),
);
const importProjectOptions = computed(() => [
  { value: "", label: "全部專案" },
  ...importProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const importSummary = computed(() => (preview: ProjectDataImportPreview) => {
  const total = (counts: ProjectDataImportPreview["additions"]): number =>
    Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    additions: total(preview.additions),
    skipped: total(preview.skipped),
    conflicts: total(preview.conflicts),
    projects: preview.additions.projects ?? 0,
    sessions: preview.additions.sessions ?? 0,
    knowledge: preview.additions.knowledge ?? 0,
  };
});
const importProjectResolutionLabels = {
  existing: "對應既有專案",
  new: "將新增專案",
  conflict: "專案衝突",
} as const;

function exportPortableData(): Promise<void> {
  if (exportScope.value === "project") {
    return exportProjectId.value
      ? exportProjectData({ type: "project", projectId: exportProjectId.value })
      : Promise.resolve();
  }
  return exportProjectData({ type: "all" });
}

function onImportFileChange(event: Event): Promise<void> {
  const input = event.target;
  return loadImportFile(input instanceof HTMLInputElement ? input.files?.[0] : undefined);
}

onMounted(() => {
  void loadBackups();
  void loadProjects();
});
</script>

<template>
  <div class="backup-section">
    <UiFlash v-if="backupsError" tone="danger">{{ backupsError }}</UiFlash>

    <UiBox>
      <template #header>
        <UiBoxTitle :icon="Archive" eyebrow="Backups" title="資料備份" :count="backups.length" />
        <div class="backup-section__actions">
          <UiIconButton
            :icon="RefreshCw"
            label="重新整理備份清單"
            size="sm"
            :loading="backupsLoading"
            @click="loadBackups"
          />
          <UiButton size="sm" :icon="DatabaseBackup" :loading="backupCreating" @click="createBackup">立即備份</UiButton>
        </div>
      </template>
      <p class="backup-section__note">
        API server 每個 UTC 日自動備份一次，存在資料庫旁的 <code>backups/</code> 資料夾；自動與手動分開保留， 分別最多
        {{ automaticBackupKeep }} 份與 {{ backupKeep }} 份。
      </p>
      <UiEmptyState
        v-if="backups.length === 0 && !backupsLoading"
        compact
        :icon="Archive"
        title="還沒有備份"
        description="按「立即備份」建立第一份。"
      />
      <!-- Past a handful of backups the list scrolls inside its Box instead of stretching the page. -->
      <VirtualList
        v-else
        :items="backups"
        :enabled="backups.length > scrollAfter"
        :estimate-item-height="60"
        max-height="min(50vh, 420px)"
        label="備份清單"
      >
        <template #default="{ item }">
          <UiBoxRow
            :title="item.fileName"
            :meta="`${item.kind === 'automatic' ? '每日自動' : '手動'} · ${formatRelative(item.createdAt)} · ${formatBytes(item.bytes)}`"
          >
            <template #leading><Archive :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
            <template #trailing
              ><time :datetime="item.createdAt" class="backup-section__time">{{
                formatDate(item.createdAt)
              }}</time></template
            >
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle :icon="Download" eyebrow="Move to another computer" title="匯出整份資料" />
        <UiButton size="sm" variant="primary" :icon="Download" :loading="databaseExporting" @click="exportDatabase"
          >匯出</UiButton
        >
      </template>
      <p>
        匯出一個 <code>.sqlite</code> 檔，包含所有專案、Session、Knowledge、報告與
        handoff。檔案沒有加密，請用可信任的方式帶到新電腦。
      </p>
      <ol class="backup-section__steps">
        <li>在新電腦安裝 Work Intelligence 並執行 <code>pnpm build</code>。</li>
        <li>確認 API server 沒有在執行，也關閉會啟動 MCP 的 Codex／Claude 對話。</li>
        <li>
          在 repo 根目錄執行下面的指令。專案在新電腦的位置不同時，用
          <code>--remap-root</code> 換掉路徑前綴；位置相同就不用加。
        </li>
      </ol>
      <div class="backup-section__command">
        <code>{{ restoreCommand }}</code>
        <UiCopyButton :text="restoreCommand" label="複製還原指令" success-message="已複製還原指令。" size="sm" />
      </div>
      <p class="backup-section__hint">
        還原前會自動備份新電腦上原本的資料；比目前版本新的資料檔會被拒絕，請先更新 Work Intelligence。
      </p>
    </UiBox>

    <UiBox padded>
      <template #header>
        <UiBoxTitle :icon="Archive" eyebrow="Portable project data" title="依專案匯出與匯入" :count="projects.length" />
      </template>
      <UiFlash v-if="transferError" tone="danger">{{ transferError }}</UiFlash>
      <p class="backup-section__hint">
        JSON 匯出檔沒有加密。匯入會合併資料，先顯示新增、略過與衝突數量，再由你確認執行；新匯入的專案會先暫停記錄。
      </p>

      <div class="transfer-controls">
        <UiField label="匯出範圍">
          <UiSelect v-model="exportScope" :options="exportScopeOptions" label="選擇匯出範圍" />
        </UiField>
        <UiField v-if="exportScope === 'project'" label="匯出專案">
          <UiSelect
            v-model="exportProjectId"
            :options="exportProjectOptions"
            label="選擇匯出專案"
            :disabled="projects.length === 0"
          />
        </UiField>
        <UiButton
          size="sm"
          :icon="Download"
          :loading="portableExporting"
          :disabled="exportScope === 'project' && !exportProjectId"
          @click="exportPortableData"
        >
          匯出 JSON
        </UiButton>
      </div>

      <div class="transfer-controls transfer-controls--import">
        <UiField label="匯入檔" hint="選擇 Work Intelligence 的 .json 匯出檔，最大 50 MiB。">
          <!-- The native file picker is required so the user can select a local export without uploading it elsewhere. -->
          <input
            class="backup-section__file-input"
            type="file"
            accept=".json,application/json"
            :disabled="importLoading"
            @change="onImportFileChange"
          />
        </UiField>
        <UiField v-if="importProjects.length > 1" label="匯入範圍">
          <UiSelect v-model="importProjectId" :options="importProjectOptions" label="選擇匯入範圍" />
        </UiField>
        <UiField label="舊電腦路徑前綴" hint="換電腦且專案位置不同時，填寫原始路徑。">
          <UiTextInput v-model="importRemapFrom" placeholder="例如：/Users/old/projects" />
        </UiField>
        <UiField label="新電腦路徑前綴" hint="留空時不變更路徑。">
          <UiTextInput v-model="importRemapTo" placeholder="例如：/Users/me/projects" />
        </UiField>
        <UiButton size="sm" :loading="importLoading" :disabled="!importFileName" @click="previewProjectDataImport">
          預覽匯入
        </UiButton>
      </div>

      <UiFlash v-if="importError" tone="danger">{{ importError }}</UiFlash>
      <div v-if="importPreview" class="transfer-preview" data-testid="project-import-preview" aria-live="polite">
        <p>匯入專案與套用路徑</p>
        <VirtualList
          :items="importPreview.selectedProjects"
          :enabled="importPreview.selectedProjects.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          label="匯入專案與路徑"
          data-testid="project-import-selected-projects"
        >
          <template #default="{ item }">
            <UiBoxRow
              class="transfer-preview__project-row"
              :title="item.name"
              :meta="`${item.rootPath} · ${importProjectResolutionLabels[item.resolution]}`"
            />
          </template>
        </VirtualList>
        <div class="transfer-preview__counts">
          <div data-testid="project-import-additions">
            <span>新增</span>
            <strong>{{ importSummary(importPreview).additions }}</strong>
            <small
              >專案 {{ importSummary(importPreview).projects }} · Session {{ importSummary(importPreview).sessions }} ·
              Knowledge {{ importSummary(importPreview).knowledge }}</small
            >
          </div>
          <div data-testid="project-import-skipped">
            <span>略過</span>
            <strong>{{ importSummary(importPreview).skipped }}</strong>
          </div>
          <div data-testid="project-import-conflicts">
            <span>衝突</span>
            <strong>{{ importSummary(importPreview).conflicts }}</strong>
          </div>
        </div>
        <p v-if="importPreview.remappedPaths.length > 0" class="backup-section__hint">
          路徑轉換：{{ importRemapFrom }} → {{ importRemapTo }}（專案
          {{ importPreview.remappedPaths[0]?.projects ?? 0 }} 個、handoff
          {{ importPreview.remappedPaths[0]?.snapshots ?? 0 }} 個）
        </p>
        <VirtualList
          v-if="importPreview.conflictDetails.length > 0"
          :items="importPreview.conflictDetails"
          :enabled="importPreview.conflictDetails.length > 4"
          :estimate-item-height="68"
          max-height="min(40vh, 320px)"
          label="匯入衝突"
        >
          <template #default="{ item }">
            <UiBoxRow :title="item.reason" :meta="`${item.table} · ${item.id}`" />
          </template>
        </VirtualList>
        <p v-if="importPreview.conflictDetailsTruncated" class="backup-section__hint">
          衝突明細超過 100 筆，僅顯示前 100 筆。
        </p>
        <p class="backup-section__hint">匯入不會覆寫衝突或已存在的資料，也不會改變既有專案的記錄狀態。</p>
        <UiButton size="sm" variant="primary" :loading="importLoading" @click="applyProjectDataImport"
          >確認並匯入</UiButton
        >
      </div>
    </UiBox>
  </div>
</template>

<style scoped>
.backup-section {
  display: grid;
  gap: var(--space-4);
}

.backup-section > .ui-box + .ui-box {
  margin-top: 0;
}

.backup-section__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.backup-section__note,
.backup-section__hint,
.backup-section__time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.backup-section__note {
  padding: var(--space-3) var(--space-4) 0;
}

.backup-section__hint {
  margin-top: var(--space-3);
}

.backup-section__steps {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0;
  padding-left: var(--space-6);
}

.backup-section__command {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.backup-section__command code {
  flex: 1 1 280px;
  min-width: 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.transfer-controls {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(180px, 1fr) auto;
  align-items: end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.transfer-controls--import {
  grid-template-columns: minmax(220px, 1.3fr) repeat(2, minmax(160px, 1fr)) minmax(160px, 1fr) auto;
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.backup-section__file-input {
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg);
  font-size: var(--text-xs);
}

.backup-section__file-input::file-selector-button {
  margin-right: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.backup-section__file-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.transfer-preview {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.transfer-preview__project-row :deep(.ui-box-row__meta) {
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}

.transfer-preview__counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.transfer-preview__counts > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.transfer-preview__counts span,
.transfer-preview__counts small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.transfer-preview__counts strong {
  font-size: var(--text-lg);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1279px) {
  .transfer-controls,
  .transfer-controls--import {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .transfer-controls,
  .transfer-controls--import,
  .transfer-preview__counts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

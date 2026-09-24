<script setup lang="ts">
import { onMounted } from "vue";
import { Archive, DatabaseBackup, Download, RefreshCw } from "lucide-vue-next";
import { useBackups } from "../../composables/useBackups";
import { formatBytes, formatDate, formatRelative } from "../../utils/format";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCopyButton from "../ui/UiCopyButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";

/**
 * Database backups and the whole-database export for moving to another computer. Restoring replaces
 * the database while nothing may hold it open, so it is a terminal command, not a button here.
 */
const {
  backups,
  backupKeep,
  backupsLoading,
  backupsError,
  backupCreating,
  databaseExporting,
  loadBackups,
  createBackup,
  exportDatabase,
} = useBackups();

const restoreCommand = "pnpm db:restore <匯出的檔案> --remap-root <舊電腦的專案上層路徑>=<新電腦的路徑>";

onMounted(() => void loadBackups());
</script>

<template>
  <div class="backup-section">
    <UiFlash v-if="backupsError" tone="danger">{{ backupsError }}</UiFlash>

    <UiBox>
      <template #header>
        <UiBoxTitle :icon="Archive" eyebrow="Backups" title="自動備份" :count="backups.length" />
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
        API server 執行時每天自動備份一次，存在資料庫旁的 <code>backups/</code> 資料夾，保留最近 {{ backupKeep }} 份。
      </p>
      <UiEmptyState
        v-if="backups.length === 0 && !backupsLoading"
        compact
        :icon="Archive"
        title="還沒有備份"
        description="按「立即備份」建立第一份。"
      />
      <UiBoxRow
        v-for="backup in backups"
        :key="backup.fileName"
        :title="backup.fileName"
        :meta="`${formatRelative(backup.createdAt)} · ${formatBytes(backup.bytes)}`"
      >
        <template #leading><Archive :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
        <template #trailing
          ><time :datetime="backup.createdAt" class="backup-section__time">{{
            formatDate(backup.createdAt)
          }}</time></template
        >
      </UiBoxRow>
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
</style>

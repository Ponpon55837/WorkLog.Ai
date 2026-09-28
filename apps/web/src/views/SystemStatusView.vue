<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { Activity, Archive, Clock3, Code2, Database, RefreshCw, Wifi } from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import StatusLabel from "../components/domain/StatusLabel.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiField from "../components/ui/UiField.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import { formatBytes, formatDate } from "../utils/format";
import { databaseInspectionStatus, databaseMaintenanceStatus, mcpRuntimeStatusVisual } from "../utils/status";
import { usePreferencesStore } from "../stores/preferences";
import { useSystemStatusStore } from "../stores/system-status";
import { EDITOR_PROTOCOLS, editorProtocolLabels } from "../utils/code-links";

const systemStatusStore = useSystemStatusStore();
const { editor } = storeToRefs(usePreferencesStore());
const {
  systemStatus: status,
  systemStatusLoading: loading,
  systemStatusError: error,
  databaseStatus,
} = storeToRefs(systemStatusStore);
const { refreshSystemStatus } = systemStatusStore;
const mcpStatus = computed(() => (status.value ? mcpRuntimeStatusVisual(status.value.mcp) : undefined));
const editorOptions = EDITOR_PROTOCOLS.map((value) => ({ value, label: editorProtocolLabels[value] }));

systemStatusStore.setSystemStatusActive(true);
onBeforeUnmount(() => systemStatusStore.setSystemStatusActive(false));
</script>

<template>
  <PageHeader description="查看本機資料庫、備份、維護與連線狀態。完整環境診斷請在專案目錄執行 pnpm run doctor。">
    <template #actions>
      <UiButton :icon="RefreshCw" :disabled="loading" @click="refreshSystemStatus">重新整理狀態</UiButton>
    </template>
  </PageHeader>

  <UiFlash v-if="error" tone="danger" title="無法載入系統狀態">
    {{ error }}
    <template #actions><UiButton size="sm" @click="refreshSystemStatus">重試</UiButton></template>
  </UiFlash>

  <UiSkeleton v-if="loading && !status" variant="card" :count="4" />

  <template v-else-if="status">
    <UiFlash v-if="status.mcp.restartRequired" tone="attention" title="MCP 需要重新連線">
      {{ status.mcp.message ?? "Work Intelligence MCP 建置已更新，請重新連線 MCP。" }}
    </UiFlash>
    <UiFlash v-else-if="!status.mcp.monitoringAvailable" tone="attention" title="無法確認 MCP 建置狀態">
      {{ status.mcp.message ?? "無法確認磁碟上的 MCP 建置。" }}
    </UiFlash>
    <div class="system-status__stats">
      <UiStatCard
        label="程式版本"
        :icon="Activity"
        :value="`v${status.version}`"
        :foot="`支援 Schema v${status.schemaVersion}`"
      />
      <UiStatCard
        label="資料庫大小"
        :icon="Database"
        :value="status.database.bytes === null ? '無法取得' : formatBytes(status.database.bytes)"
        :foot="`資料庫 Schema v${status.database.schemaVersion ?? '未知'}`"
      />
      <UiStatCard
        label="備份"
        :icon="Archive"
        :value="status.backups.available ? status.backups.count : '不可用'"
        suffix="份"
        :foot="`合計 ${formatBytes(status.backups.totalBytes)}`"
      />
      <UiStatCard
        label="SSE 連線"
        :icon="Wifi"
        :value="status.sseConnections"
        suffix="個"
        foot="目前開啟的即時更新連線"
      />
    </div>

    <div class="system-status__details">
      <UiBox>
        <template #header>
          <UiBoxTitle :icon="Database" title="資料庫" />
          <StatusLabel :status="databaseStatus" />
        </template>
        <UiBoxRow title="位置">
          <template #meta
            ><code class="system-status__path">{{ status.database.path }}</code></template
          >
        </UiBoxRow>
        <UiBoxRow
          title="大小"
          :meta="status.database.bytes === null ? '無法取得' : formatBytes(status.database.bytes)"
        />
        <UiBoxRow title="資料庫 Schema" :meta="`v${status.database.schemaVersion ?? '未知'}`" />
      </UiBox>

      <UiBox>
        <template #header><UiBoxTitle :icon="Archive" title="備份" :count="status.backups.count" /></template>
        <UiBoxRow title="總大小" :meta="formatBytes(status.backups.totalBytes)" />
        <UiBoxRow title="最近自動備份">
          <template #meta>
            <template v-if="status.backups.latestAutomatic">
              <time :datetime="status.backups.latestAutomatic.createdAt">
                {{ formatDate(status.backups.latestAutomatic.createdAt) }}
              </time>
              <code class="system-status__backup-name">{{ status.backups.latestAutomatic.fileName }}</code>
            </template>
            <span v-else>尚無自動備份</span>
          </template>
        </UiBoxRow>
        <UiBoxRow v-if="!status.backups.available" title="備份資訊" meta="目前資料庫不支援備份清單" />
      </UiBox>

      <UiBox>
        <template #header>
          <UiBoxTitle :icon="Activity" title="MCP 連線" :count="status.mcp.activeProcesses" />
          <StatusLabel v-if="mcpStatus" :status="mcpStatus" />
        </template>
        <UiBoxRow title="需要重新連線" :meta="`${status.mcp.outdatedProcesses} 個`" />
        <UiBoxRow
          v-if="!status.mcp.monitoringAvailable"
          title="目前狀態"
          :meta="status.mcp.message ?? '無法確認 MCP heartbeat 狀態'"
        />
        <UiBoxRow
          v-else-if="status.mcp.activeProcesses === 0"
          title="目前狀態"
          meta="尚無可監測的 MCP heartbeat；重新連線後可確認 Agent 使用的建置"
        />
        <UiBoxRow v-else title="目前狀態" :meta="status.mcp.message ?? 'MCP heartbeat 正常'" />
      </UiBox>

      <UiBox>
        <template #header><UiBoxTitle :icon="Clock3" title="最近資料維護" /></template>
        <UiBoxRow v-if="status.maintenance" title="維護結果">
          <template #labels>
            <StatusLabel :status="databaseMaintenanceStatus[status.maintenance.status]" />
            <StatusLabel
              v-if="status.maintenance.failureCode"
              :status="databaseInspectionStatus.unhealthy"
              :text="status.maintenance.failureCode"
            />
          </template>
          <template #meta>
            {{ formatDate(status.maintenance.completedAt ?? status.maintenance.startedAt) }}
          </template>
          <p class="system-status__maintenance-meta">
            備份 {{ status.maintenance.backupFileName }} · {{ status.maintenance.indexedSessions }} 個 Sessions ·
            {{ status.maintenance.indexedKnowledge }} 筆 Knowledge
          </p>
        </UiBoxRow>
        <UiBoxRow v-else title="尚無維護紀錄" meta="執行 pnpm db:maintain 後會顯示最近結果" />
      </UiBox>
    </div>
  </template>

  <UiBox class="system-status__preferences" data-testid="preferences">
    <template #header><UiBoxTitle :icon="Code2" title="個人偏好" /></template>
    <div class="system-status__preference">
      <UiField
        label="用編輯器開啟檔案"
        hint="選擇後，Session 的 changed files 旁會出現「在編輯器開啟」。只存在這個瀏覽器，只為記錄中的專案、且不會超出專案資料夾的路徑產生連結。"
      >
        <UiSelect v-model="editor" :options="editorOptions" label="用來開啟檔案的編輯器" />
      </UiField>
    </div>
  </UiBox>
</template>

<style scoped>
.system-status__preferences {
  margin-top: var(--space-4);
}

.system-status__preference {
  max-width: 480px;
  padding: var(--space-3) var(--space-4);
}

.system-status__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.system-status__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  align-items: start;
}

.system-status__details > .ui-box + .ui-box {
  margin-top: 0;
}

.system-status__path,
.system-status__backup-name {
  display: block;
  overflow-wrap: anywhere;
  white-space: normal;
}

.system-status__maintenance-meta {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 959px) {
  .system-status__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .system-status__details {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

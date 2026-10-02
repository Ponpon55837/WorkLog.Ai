<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import {
  Activity,
  Archive,
  Bot,
  CircleAlert,
  CircleCheck,
  Clock3,
  Code2,
  Database,
  Power,
  RefreshCw,
  Settings2,
  Wifi,
} from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import StatusLabel from "../components/domain/StatusLabel.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiCopyButton from "../components/ui/UiCopyButton.vue";
import UiField from "../components/ui/UiField.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiGroupLabel from "../components/ui/UiGroupLabel.vue";
import UiSegmentedControl from "../components/ui/UiSegmentedControl.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import { usePreferencesStore, type ThemePreference } from "../stores/preferences";
import { useSystemStatusStore } from "../stores/system-status";
import { EDITOR_PROTOCOLS, editorProtocolLabels } from "../utils/code-links";
import { formatBytes, formatDate } from "../utils/format";
import {
  agentConnectionGroups,
  databaseInspectionStatus,
  databaseMaintenanceStatus,
  mcpReconnectStatusVisual,
  mcpRuntimeStatusVisual,
  userServiceStatusVisual,
  type StatusVisual,
} from "../utils/status";
import { LOCALE_OPTIONS, t } from "../i18n";

const SETUP_COMMAND = "pnpm setup:agents";
const editorOptions = EDITOR_PROTOCOLS.map((value) => ({ value, label: editorProtocolLabels[value] }));
const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: t("跟隨系統") },
  { value: "light", label: t("淺色") },
  { value: "dark", label: t("深色") },
];

const systemStatusStore = useSystemStatusStore();
const { editor, locale, theme } = storeToRefs(usePreferencesStore());
const {
  systemStatus: status,
  systemStatusLoading: loading,
  systemStatusError: error,
  databaseStatus,
} = storeToRefs(systemStatusStore);
const { refreshSystemStatus } = systemStatusStore;

const mcpStatus = computed(() => (status.value ? mcpRuntimeStatusVisual(status.value.mcp) : undefined));
const agentGroups = computed(() => (status.value ? agentConnectionGroups(status.value.agents) : []));
const agentIssueCount = computed(() =>
  agentGroups.value.reduce((count, group) => count + group.rows.filter((row) => !row.ok).length, 0),
);
const agentSummary = computed<StatusVisual>(() =>
  agentIssueCount.value === 0
    ? { tone: "success", icon: CircleCheck, label: t("全部正常") }
    : {
        tone: "attention",
        icon: CircleAlert,
        label: t("{agentIssueCount} 項需處理", { agentIssueCount: agentIssueCount.value }),
      },
);
const userServiceStatus = computed(() =>
  status.value ? userServiceStatusVisual(status.value.userService) : undefined,
);

systemStatusStore.setSystemStatusActive(true);
onBeforeUnmount(() => systemStatusStore.setSystemStatusActive(false));
</script>

<template>
  <PageHeader
    :description="t('查看本機服務、資料庫、備份、維護與連線狀態。完整環境診斷請在專案目錄執行 pnpm run doctor。')"
  >
    <template #actions>
      <UiButton :icon="RefreshCw" :disabled="loading" @click="refreshSystemStatus">{{ t("重新整理狀態") }}</UiButton>
    </template>
  </PageHeader>

  <UiFlash v-if="error" tone="danger" :title="t('無法載入系統狀態')">
    {{ error }}
    <template #actions
      ><UiButton size="sm" @click="refreshSystemStatus">{{ t("重試") }}</UiButton></template
    >
  </UiFlash>

  <UiSkeleton v-if="loading && !status" variant="card" :count="4" />

  <template v-else-if="status">
    <UiFlash v-if="status.mcp.restartRequired" tone="attention" :title="t('MCP 需要重新連線')">
      {{ status.mcp.message ?? t("Work Intelligence MCP 建置已更新，請重新連線 MCP。") }}
    </UiFlash>
    <UiFlash v-else-if="!status.mcp.monitoringAvailable" tone="attention" :title="t('無法確認 MCP 建置狀態')">
      {{ status.mcp.message ?? t("無法確認磁碟上的 MCP 建置。") }}
    </UiFlash>

    <div class="system-status__stats">
      <UiStatCard
        :label="t('程式版本')"
        :icon="Activity"
        :value="`v${status.version}`"
        :foot="t('支援 Schema v{schemaVersion}', { schemaVersion: status.schemaVersion })"
      />
      <UiStatCard
        :label="t('資料庫大小')"
        :icon="Database"
        :value="status.database.bytes === null ? t('無法取得') : formatBytes(status.database.bytes)"
        :foot="t('資料庫 Schema v{value}', { value: status.database.schemaVersion ?? t('未知') })"
      />
      <UiStatCard
        :label="t('備份')"
        :icon="Archive"
        :value="status.backups.available ? status.backups.count : t('不可用')"
        :suffix="t('份')"
        :foot="t('合計 {value}', { value: formatBytes(status.backups.totalBytes) })"
      />
      <UiStatCard
        :label="t('SSE 連線')"
        :icon="Wifi"
        :value="status.sseConnections"
        :suffix="t('個')"
        :foot="t('目前開啟的即時更新連線')"
      />
    </div>

    <div class="system-status__layout">
      <div class="system-status__main">
        <UiBox data-testid="agent-connections">
          <template #header>
            <UiBoxTitle :icon="Bot" :title="t('Agent 連線')" />
            <StatusLabel :status="agentSummary" />
          </template>
          <div v-if="agentIssueCount > 0" class="system-status__setup" data-testid="agent-setup-hint">
            <p>
              {{
                t(
                  "其他專案的 Agent 需要使用者層級的 skill 與 hook，才會自動讀取說明並提醒保存工作記錄。在 Work Intelligence 專案目錄執行下列指令：先預覽要寫入的設定，確認後才寫入；完成後重新連線 Agent。",
                )
              }}
            </p>
            <div class="system-status__command">
              <code>{{ SETUP_COMMAND }}</code>
              <UiCopyButton :text="SETUP_COMMAND" size="sm" :label="t('複製指令')" />
            </div>
          </div>
          <template v-for="group in agentGroups" :key="group.agent">
            <UiGroupLabel>{{ group.agent }}</UiGroupLabel>
            <UiBoxRow v-for="row in group.rows" :key="row.title" :title="row.title">
              <template #labels><StatusLabel :status="row.status" /></template>
              <template #meta
                ><code class="system-status__location">{{ row.location }}</code></template
              >
            </UiBoxRow>
          </template>
        </UiBox>

        <UiBox data-testid="preferences">
          <template #header><UiBoxTitle :icon="Settings2" :title="t('個人偏好')" /></template>
          <div class="system-status__preference">
            <UiField :label="t('外觀主題')" :hint="t('「跟隨系統」會隨作業系統的淺色／深色設定自動切換。')">
              <UiSegmentedControl v-model="theme" :options="themeOptions" :label="t('外觀主題')" />
            </UiField>
            <UiField :label="t('介面語言')" :hint="t('只改變介面文字；Session 與報告內容維持原本記錄的語言。')">
              <UiSegmentedControl v-model="locale" :options="LOCALE_OPTIONS" :label="t('介面語言')" />
            </UiField>
            <UiField
              :label="t('用編輯器開啟檔案')"
              :hint="
                t(
                  '選擇後，Session 的 changed files 旁會出現「在編輯器開啟」。只存在這個瀏覽器，只為記錄中的專案、且不會超出專案資料夾的路徑產生連結。',
                )
              "
            >
              <UiSelect v-model="editor" :options="editorOptions" :label="t('用來開啟檔案的編輯器')" />
            </UiField>
          </div>
        </UiBox>
      </div>

      <aside class="system-status__side" :aria-label="t('資料與連線')">
        <UiBox data-testid="user-service">
          <template #header>
            <UiBoxTitle :icon="Power" :title="t('登入自動啟動')" />
            <StatusLabel v-if="userServiceStatus" :status="userServiceStatus" />
          </template>
          <UiBoxRow :title="t('服務管理器')" :meta="status.userService.manager ?? t('此平台不支援')" />
          <UiBoxRow
            :title="t('登入時啟動')"
            :meta="status.userService.enabled === null ? t('無法判定') : status.userService.enabled ? t('是') : t('否')"
          />
          <UiBoxRow :title="t('服務設定')">
            <template #meta>
              <code class="system-status__location">{{ status.userService.configPath ?? t("不適用") }}</code>
            </template>
          </UiBoxRow>
          <UiBoxRow :title="t('服務日誌')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.logPath }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow :title="t('服務使用的資料庫')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.databasePath }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow :title="t('服務備份目錄')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.backupDirectory }}</code></template
            >
          </UiBoxRow>
        </UiBox>

        <UiBox data-testid="mcp-connection">
          <template #header>
            <UiBoxTitle :icon="Code2" :title="t('MCP 連線')" :count="status.mcp.activeProcesses" />
            <StatusLabel v-if="mcpStatus" :status="mcpStatus" />
          </template>
          <UiBoxRow :title="t('重新連線')" data-testid="agent-mcp-reconnect">
            <template #labels><StatusLabel :status="mcpReconnectStatusVisual(status.mcp)" /></template>
            <template #meta>{{ status.mcp.message ?? t("以 MCP heartbeat 判斷目前是否需要重新連線。") }}</template>
          </UiBoxRow>
          <UiBoxRow
            :title="t('有新版可用的程序')"
            :meta="
              t('{updateAvailableProcesses} 個', { updateAvailableProcesses: status.mcp.updateAvailableProcesses })
            "
          />
          <UiBoxRow
            :title="t('需要重新連線的程序')"
            :meta="t('{outdatedProcesses} 個', { outdatedProcesses: status.mcp.outdatedProcesses })"
          />
        </UiBox>

        <UiBox>
          <template #header>
            <UiBoxTitle :icon="Database" :title="t('資料庫')" />
            <StatusLabel :status="databaseStatus" />
          </template>
          <UiBoxRow :title="t('位置')">
            <template #meta
              ><code class="system-status__location">{{ status.database.path }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow
            :title="t('大小與 Schema')"
            :meta="`${status.database.bytes === null ? t('無法取得') : formatBytes(status.database.bytes)} · v${status.database.schemaVersion ?? t('未知')}`"
          />
        </UiBox>

        <UiBox>
          <template #header><UiBoxTitle :icon="Archive" :title="t('備份')" :count="status.backups.count" /></template>
          <UiBoxRow v-if="!status.backups.available" :title="t('備份資訊')" :meta="t('目前資料庫不支援備份清單')" />
          <UiBoxRow :title="t('最近自動備份')">
            <template #meta>
              <template v-if="status.backups.latestAutomatic">
                <time :datetime="status.backups.latestAutomatic.createdAt">
                  {{ formatDate(status.backups.latestAutomatic.createdAt) }}
                </time>
                <code class="system-status__location">{{ status.backups.latestAutomatic.fileName }}</code>
              </template>
              <span v-else>{{ t("尚無自動備份") }}</span>
            </template>
          </UiBoxRow>
        </UiBox>

        <UiBox>
          <template #header><UiBoxTitle :icon="Clock3" :title="t('最近資料維護')" /></template>
          <UiBoxRow v-if="status.maintenance" :title="t('維護結果')">
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
              {{
                t("備份 {backupFileName} · {indexedSessions} 個 Sessions · {indexedKnowledge} 筆 Knowledge", {
                  backupFileName: status.maintenance.backupFileName,
                  indexedSessions: status.maintenance.indexedSessions,
                  indexedKnowledge: status.maintenance.indexedKnowledge,
                })
              }}
            </p>
          </UiBoxRow>
          <UiBoxRow v-else :title="t('尚無維護紀錄')" :meta="t('執行 pnpm db:maintain 後會顯示最近結果')" />
        </UiBox>
      </aside>
    </div>
  </template>
</template>

<style scoped>
.system-status__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.system-status__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--space-4);
  align-items: start;
}

.system-status__main,
.system-status__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.system-status__main > .ui-box + .ui-box,
.system-status__side > .ui-box + .ui-box {
  margin-top: 0;
}

.system-status__setup {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.system-status__command {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.system-status__command code {
  flex: 1;
  min-width: 0;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.system-status__location {
  display: block;
  overflow-wrap: anywhere;
  white-space: normal;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.system-status__preference {
  display: grid;
  gap: var(--space-4);
  max-width: 480px;
  padding: var(--space-3) var(--space-4);
}

.system-status__maintenance-meta {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 1199px) {
  .system-status__layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 959px) {
  .system-status__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

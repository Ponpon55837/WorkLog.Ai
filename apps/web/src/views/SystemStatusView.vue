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
  { value: "system", label: t("systemStatus.followSystem") },
  { value: "light", label: t("systemStatus.light") },
  { value: "dark", label: t("systemStatus.dark") },
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
    ? { tone: "success", icon: CircleCheck, label: t("systemStatus.allHealthy") }
    : {
        tone: "attention",
        icon: CircleAlert,
        label: t("systemStatus.needAttention", { agentIssueCount: agentIssueCount.value }),
      },
);
const userServiceStatus = computed(() =>
  status.value ? userServiceStatusVisual(status.value.userService) : undefined,
);

systemStatusStore.setSystemStatusActive(true);
onBeforeUnmount(() => systemStatusStore.setSystemStatusActive(false));
</script>

<template>
  <PageHeader :description="t('systemStatus.localServiceDatabaseBackupMaintenance')">
    <template #actions>
      <UiButton :icon="RefreshCw" :disabled="loading" @click="refreshSystemStatus">{{
        t("systemStatus.refreshStatus")
      }}</UiButton>
    </template>
  </PageHeader>

  <UiFlash v-if="error" tone="danger" :title="t('systemStatus.couldNotLoadSystemStatus')">
    {{ error }}
    <template #actions
      ><UiButton size="sm" @click="refreshSystemStatus">{{ t("common.retry") }}</UiButton></template
    >
  </UiFlash>

  <UiSkeleton v-if="loading && !status" variant="card" :count="4" :label="t('systemStatus.loadingSystemStatus')" />

  <template v-else-if="status">
    <UiFlash v-if="status.mcp.restartRequired" tone="attention" :title="t('systemStatus.mcpNeedsToReconnect')">
      {{ status.mcp.message ?? t("systemStatus.theWorkIntelligenceMcpBuild") }}
    </UiFlash>
    <UiFlash
      v-else-if="!status.mcp.monitoringAvailable"
      tone="attention"
      :title="t('systemStatus.cannotConfirmTheMcpBuild')"
    >
      {{ status.mcp.message ?? t("systemStatus.cannotConfirmTheMcpBuildOnDisk") }}
    </UiFlash>

    <div class="system-status__stats">
      <UiStatCard
        :label="t('systemStatus.appVersion')"
        :icon="Activity"
        :value="`v${status.version}`"
        :foot="t('systemStatus.supportsSchemaV', { schemaVersion: status.schemaVersion })"
      />
      <UiStatCard
        :label="t('systemStatus.databaseSize')"
        :icon="Database"
        :value="
          status.database.bytes === null ? t('systemStatus.unavailableValue') : formatBytes(status.database.bytes)
        "
        :foot="t('systemStatus.databaseSchemaV', { value: status.database.schemaVersion ?? t('systemStatus.unknown') })"
      />
      <UiStatCard
        :label="t('systemStatus.backupsLabel')"
        :icon="Archive"
        :value="status.backups.available ? status.backups.count : t('systemStatus.unavailable')"
        :suffix="t('systemStatus.backups')"
        :foot="t('systemStatus.total', { value: formatBytes(status.backups.totalBytes) })"
      />
      <UiStatCard
        :label="t('systemStatus.sseConnection')"
        :icon="Wifi"
        :value="status.sseConnections"
        :suffix="t('systemStatus.open')"
        :foot="t('systemStatus.liveUpdateConnectionsCurrentlyOpen')"
      />
    </div>

    <div class="system-status__layout">
      <div class="system-status__main">
        <UiBox data-testid="agent-connections">
          <template #header>
            <UiBoxTitle :icon="Bot" :title="t('systemStatus.agentConnections')" />
            <StatusLabel :status="agentSummary" />
          </template>
          <div v-if="agentIssueCount > 0" class="system-status__setup" data-testid="agent-setup-hint">
            <p>
              {{ t("systemStatus.agentsInOtherProjectsNeed") }}
            </p>
            <div class="system-status__command">
              <code>{{ SETUP_COMMAND }}</code>
              <UiCopyButton :text="SETUP_COMMAND" size="sm" :label="t('systemStatus.copyCommand')" />
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
          <template #header><UiBoxTitle :icon="Settings2" :title="t('systemStatus.personalPreferences')" /></template>
          <div class="system-status__preference">
            <UiField group :label="t('systemStatus.appearance')" :hint="t('systemStatus.followSystemSwitchesWithYour')">
              <UiSegmentedControl v-model="theme" :options="themeOptions" :label="t('systemStatus.appearance')" />
            </UiField>
            <UiField group :label="t('common.language')" :hint="t('systemStatus.changesInterfaceTextOnlySessions')">
              <UiSegmentedControl v-model="locale" :options="LOCALE_OPTIONS" :label="t('common.language')" />
            </UiField>
            <UiField :label="t('systemStatus.openFilesInAnEditor')" :hint="t('systemStatus.onceChosenOpenInEditor')">
              <UiSelect v-model="editor" :options="editorOptions" :label="t('systemStatus.editorUsedToOpenFiles')" />
            </UiField>
          </div>
        </UiBox>
      </div>

      <aside class="system-status__side" :aria-label="t('systemStatus.dataAndConnections')">
        <UiBox data-testid="user-service">
          <template #header>
            <UiBoxTitle :icon="Power" :title="t('systemStatus.startAutomaticallyAtLogin')" />
            <StatusLabel v-if="userServiceStatus" :status="userServiceStatus" />
          </template>
          <UiBoxRow
            :title="t('systemStatus.serviceManager')"
            :meta="status.userService.manager ?? t('systemStatus.notSupportedOnThisPlatform')"
          />
          <UiBoxRow
            :title="t('systemStatus.startAtLogin')"
            :meta="
              status.userService.enabled === null
                ? t('systemStatus.cannotTell')
                : status.userService.enabled
                  ? t('common.yes')
                  : t('common.no')
            "
          />
          <UiBoxRow :title="t('systemStatus.serviceConfiguration')">
            <template #meta>
              <code class="system-status__location">{{
                status.userService.configPath ?? t("systemStatus.notApplicable")
              }}</code>
            </template>
          </UiBoxRow>
          <UiBoxRow :title="t('systemStatus.serviceLog')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.logPath }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow :title="t('systemStatus.databaseUsedByTheService')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.databasePath }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow :title="t('systemStatus.serviceBackupFolder')">
            <template #meta
              ><code class="system-status__location">{{ status.userService.backupDirectory }}</code></template
            >
          </UiBoxRow>
        </UiBox>

        <UiBox data-testid="mcp-connection">
          <template #header>
            <UiBoxTitle :icon="Code2" :title="t('systemStatus.mcpConnection')" :count="status.mcp.activeProcesses" />
            <StatusLabel v-if="mcpStatus" :status="mcpStatus" />
          </template>
          <UiBoxRow :title="t('systemStatus.reconnect')" data-testid="agent-mcp-reconnect">
            <template #labels><StatusLabel :status="mcpReconnectStatusVisual(status.mcp)" /></template>
            <template #meta>{{ status.mcp.message ?? t("systemStatus.usesTheMcpHeartbeatTo") }}</template>
          </UiBoxRow>
          <UiBoxRow
            :title="t('systemStatus.processesWithAnUpdateAvailable')"
            :meta="
              t('systemStatus.updateAvailableProcessCount', {
                updateAvailableProcesses: status.mcp.updateAvailableProcesses,
              })
            "
          />
          <UiBoxRow
            :title="t('systemStatus.processesThatNeedToReconnect')"
            :meta="t('systemStatus.outdatedProcessCount', { outdatedProcesses: status.mcp.outdatedProcesses })"
          />
        </UiBox>

        <UiBox>
          <template #header>
            <UiBoxTitle :icon="Database" :title="t('systemStatus.database')" />
            <StatusLabel :status="databaseStatus" />
          </template>
          <UiBoxRow :title="t('systemStatus.location')">
            <template #meta
              ><code class="system-status__location">{{ status.database.path }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow
            :title="t('systemStatus.sizeAndSchema')"
            :meta="`${status.database.bytes === null ? t('systemStatus.unavailableValue') : formatBytes(status.database.bytes)} · v${status.database.schemaVersion ?? t('systemStatus.unknown')}`"
          />
        </UiBox>

        <UiBox>
          <template #header
            ><UiBoxTitle :icon="Archive" :title="t('systemStatus.backupsLabel')" :count="status.backups.count"
          /></template>
          <UiBoxRow
            v-if="!status.backups.available"
            :title="t('systemStatus.backupInformation')"
            :meta="t('systemStatus.thisDatabaseDoesNotSupport')"
          />
          <UiBoxRow :title="t('systemStatus.latestAutomaticBackup')">
            <template #meta>
              <template v-if="status.backups.latestAutomatic">
                <time :datetime="status.backups.latestAutomatic.createdAt">
                  {{ formatDate(status.backups.latestAutomatic.createdAt) }}
                </time>
                <code class="system-status__location">{{ status.backups.latestAutomatic.fileName }}</code>
              </template>
              <span v-else>{{ t("systemStatus.noAutomaticBackupsYet") }}</span>
            </template>
          </UiBoxRow>
        </UiBox>

        <UiBox>
          <template #header><UiBoxTitle :icon="Clock3" :title="t('systemStatus.latestDataMaintenance')" /></template>
          <UiBoxRow v-if="status.maintenance" :title="t('systemStatus.maintenanceResult')">
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
                t("systemStatus.backupSessionsKnowledge", {
                  backupFileName: status.maintenance.backupFileName,
                  indexedSessions: status.maintenance.indexedSessions,
                  indexedKnowledge: status.maintenance.indexedKnowledge,
                })
              }}
            </p>
          </UiBoxRow>
          <UiBoxRow
            v-else
            :title="t('systemStatus.noMaintenanceHistory')"
            :meta="t('systemStatus.recentResultsAppearAfterRunning')"
          />
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

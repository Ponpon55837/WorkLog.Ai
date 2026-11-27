<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
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
  Globe,
  Power,
  RefreshCw,
  Settings2,
  Wifi,
} from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import AgentReadsBox from "../components/domain/AgentReadsBox.vue";
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
import UiSplitLayout from "../components/ui/UiSplitLayout.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import UiStatGrid from "../components/ui/UiStatGrid.vue";
import { useDesktopLanguageStore } from "../stores/desktop-language";
import { usePreferencesStore, type ThemePreference } from "../stores/preferences";
import { useSystemStatusStore } from "../stores/system-status";
import { EDITOR_PROTOCOLS, editorProtocolLabels } from "../utils/code-links";
import { formatBytes, formatDate } from "../utils/format";
import {
  agentConnectionGroups,
  agentSeenLeaseNoteKey,
  databaseInspectionStatus,
  databaseMaintenanceStatus,
  mcpReconnectStatusVisual,
  mcpRuntimeStatusVisual,
  desktopLoginItemMismatch,
  reclaimVisual,
  desktopLoginItemStatusVisual,
  userServiceStatusVisual,
  type StatusVisual,
} from "../utils/status";
import { LOCALE_OPTIONS, t, type MessageKey } from "../i18n";

const SETUP_COMMAND = "pnpm setup:agents";
const editorOptions = EDITOR_PROTOCOLS.map((value) => ({ value, label: editorProtocolLabels[value] }));
const STORAGE_RISK_TITLES = {
  network: "systemStatus.storageRiskNetwork",
  removable: "systemStatus.storageRiskRemovable",
  "cloud-sync": "systemStatus.storageRiskCloudSync",
  "hard-link": "systemStatus.storageRiskHardLink",
} as const satisfies Record<string, MessageKey>;
const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: t("systemStatus.followSystem") },
  { value: "light", label: t("systemStatus.light") },
  { value: "dark", label: t("systemStatus.dark") },
];

const router = useRouter();
const systemStatusStore = useSystemStatusStore();
const { editor, locale, theme } = storeToRefs(usePreferencesStore());
const { changeLocale } = useDesktopLanguageStore();
const {
  systemStatus: status,
  systemStatusLoading: loading,
  systemStatusError: error,
  databaseStatus,
} = storeToRefs(systemStatusStore);
const { agentSetupOpening, portSettingsOpening } = storeToRefs(systemStatusStore);
const { refreshSystemStatus, openDesktopAgentSetup, openDesktopPortSettings } = systemStatusStore;

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
const desktopLoginItem = computed(() => status.value?.desktop?.loginItem);
const desktopLoginItemStatus = computed(() => desktopLoginItemStatusVisual(desktopLoginItem.value));
const desktopLoginItemMismatched = computed(() =>
  desktopLoginItem.value ? desktopLoginItemMismatch(desktopLoginItem.value) : false,
);

const desktopAddress = computed(() => `http://127.0.0.1:${status.value?.desktop?.activePort ?? window.location.port}`);
const storageRisk = computed(() => status.value?.desktop?.storageRisk);
const storageRiskTitle = computed(() => {
  const risk = storageRisk.value?.risk;
  return risk && risk !== "unknown" ? t(STORAGE_RISK_TITLES[risk]) : "";
});

/** Hands the App the current page path only: the query and hash stay behind. */
function changePortInDesktopApp(): void {
  void openDesktopPortSettings(router.currentRoute.value.path);
}

systemStatusStore.setSystemStatusActive(true);
onBeforeUnmount(() => systemStatusStore.setSystemStatusActive(false));
</script>

<template>
  <PageHeader
    :description="
      t(
        status?.desktop?.managed
          ? 'systemStatus.localServiceStatusDesktop'
          : 'systemStatus.localServiceDatabaseBackupMaintenance',
      )
    "
  >
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
    <UiFlash v-if="!status.sqlite.walResetFixed" tone="danger" :title="t('systemStatus.sqliteWalResetTitle')">
      {{ t("systemStatus.sqliteWalResetBody", { version: status.sqlite.version }) }}
    </UiFlash>
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

    <UiStatGrid class="system-status__stats">
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
    </UiStatGrid>

    <UiSplitLayout :aside-label="t('systemStatus.dataAndConnections')">
      <template #main>
        <UiBox v-if="status.desktop?.managed" data-testid="desktop-port">
          <template #header><UiBoxTitle :icon="Globe" :title="t('systemStatus.desktopApp')" /></template>
          <UiBoxRow :title="t('systemStatus.effectiveAddress')">
            <template #meta
              ><code class="system-status__location" data-testid="desktop-address">{{ desktopAddress }}</code></template
            >
          </UiBoxRow>
          <div class="system-status__setup">
            <p>{{ t("systemStatus.portChangeHint") }}</p>
            <div>
              <UiButton :disabled="portSettingsOpening" @click="changePortInDesktopApp">{{
                t("systemStatus.changePortInDesktopApp")
              }}</UiButton>
            </div>
          </div>
          <div v-if="storageRisk" class="system-status__setup" data-testid="storage-risk">
            <template v-if="storageRisk.risk === 'unknown'">
              <p data-testid="storage-risk-unknown">{{ t("systemStatus.storageRiskUnknown") }}</p>
            </template>
            <UiFlash v-else tone="attention" :title="storageRiskTitle">
              {{
                storageRisk.risk === "hard-link"
                  ? t("systemStatus.storageRiskHardLinkBody")
                  : t("systemStatus.storageRiskBody")
              }}
              <template v-if="storageRisk.migrationBlocked">
                {{ t("systemStatus.storageRiskMigrationBlocked") }}
              </template>
            </UiFlash>
          </div>
        </UiBox>

        <UiBox data-testid="agent-connections">
          <template #header>
            <UiBoxTitle :icon="Bot" :title="t('systemStatus.agentConnections')" />
            <StatusLabel :status="agentSummary" />
          </template>
          <div v-if="status.desktop?.managed" class="system-status__setup" data-testid="desktop-agent-setup">
            <div>
              <UiButton :disabled="agentSetupOpening" @click="openDesktopAgentSetup">{{
                t("systemStatus.openAgentSetupInDesktopApp")
              }}</UiButton>
            </div>
          </div>
          <!-- The desktop App never shows a command: its own Agent setup (the button above) does the same work. -->
          <div
            v-if="agentIssueCount > 0 && status.desktop?.managed"
            class="system-status__setup"
            data-testid="agent-setup-hint-desktop"
          >
            <p>{{ t("systemStatus.agentsInOtherProjectsNeedDesktop") }}</p>
          </div>
          <div v-else-if="agentIssueCount > 0" class="system-status__setup" data-testid="agent-setup-hint">
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
              <p v-if="row.note" class="system-status__row-note">{{ row.note }}</p>
            </UiBoxRow>
          </template>
        </UiBox>

        <AgentReadsBox />

        <UiBox data-testid="preferences">
          <template #header><UiBoxTitle :icon="Settings2" :title="t('systemStatus.personalPreferences')" /></template>
          <div class="system-status__preference">
            <UiField group :label="t('systemStatus.appearance')" :hint="t('systemStatus.followSystemSwitchesWithYour')">
              <UiSegmentedControl v-model="theme" :options="themeOptions" :label="t('systemStatus.appearance')" />
            </UiField>
            <UiField group :label="t('common.language')" :hint="t('systemStatus.changesInterfaceTextOnlySessions')">
              <UiSegmentedControl
                :model-value="locale"
                :options="LOCALE_OPTIONS"
                :label="t('common.language')"
                @update:model-value="changeLocale"
              />
            </UiField>
            <UiField :label="t('systemStatus.openFilesInAnEditor')" :hint="t('systemStatus.onceChosenOpenInEditor')">
              <UiSelect v-model="editor" :options="editorOptions" :label="t('systemStatus.openFilesInAnEditor')" />
            </UiField>
          </div>
        </UiBox>
      </template>

      <template #aside>
        <UiBox v-if="status.desktop?.managed" data-testid="user-service">
          <template #header>
            <UiBoxTitle :icon="Power" :title="t('systemStatus.startAutomaticallyAtLogin')" />
            <StatusLabel :status="desktopLoginItemStatus" />
          </template>
          <template v-if="desktopLoginItem?.supported">
            <UiBoxRow :title="t('systemStatus.appLoginItemChoice')" data-testid="app-login-item-choice">
              <template #meta>{{
                desktopLoginItem.desired ? t("systemStatus.appLoginItemOn") : t("systemStatus.appLoginItemOff")
              }}</template>
            </UiBoxRow>
            <UiBoxRow :title="t('systemStatus.appLoginItemSystem')" data-testid="app-login-item-system">
              <template #meta>{{
                desktopLoginItem.system === "unknown"
                  ? t("systemStatus.appLoginItemUnknown")
                  : desktopLoginItem.system === "enabled"
                    ? t("systemStatus.appLoginItemOn")
                    : t("systemStatus.appLoginItemOff")
              }}</template>
            </UiBoxRow>
          </template>
          <p
            v-if="desktopLoginItemMismatched"
            class="system-status__row-note system-status__box-note"
            data-testid="app-login-item-mismatch"
          >
            {{ t("systemStatus.appLoginItemMismatch") }}
          </p>
          <p v-if="desktopLoginItem?.supported" class="system-status__row-note system-status__box-note">
            {{ t("systemStatus.appLoginItemChangeInApp") }}
          </p>
          <UiBoxRow :title="t('systemStatus.appDatabase')">
            <template #meta
              ><code class="system-status__location" data-testid="app-database-path">{{
                status.database.path
              }}</code></template
            >
          </UiBoxRow>
          <UiBoxRow v-if="status.desktop.backupDirectory" :title="t('systemStatus.appBackupFolder')">
            <template #meta
              ><code class="system-status__location" data-testid="app-backup-directory">{{
                status.desktop.backupDirectory
              }}</code></template
            >
          </UiBoxRow>
          <!-- The old Task Scheduler / LaunchAgent / systemd service is shown only when it is still there. -->
          <div v-if="status.desktop?.legacyService" class="system-status__setup" data-testid="legacy-service-warning">
            <UiFlash tone="attention">
              {{ t("systemStatus.legacyServiceWarning") }}
            </UiFlash>
            <p v-if="status.desktop.legacyService.running === 'stopped'" data-testid="legacy-service-starts-at-login">
              {{ t("systemStatus.legacyServiceStartsAtLogin") }}
            </p>
            <p data-testid="legacy-service-turn-off">{{ t("systemStatus.legacyServiceTurnOffInApp") }}</p>
          </div>
        </UiBox>
        <UiBox v-else data-testid="user-service">
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
          <p
            v-if="status.mcp.activeProcesses === 0 && status.mcp.agentObservedWithoutLease"
            class="system-status__row-note system-status__box-note"
            data-testid="mcp-agent-seen-without-lease"
          >
            {{ t(agentSeenLeaseNoteKey(status.mcp)) }}
          </p>
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
            v-if="status.database.reclaimableBytes !== undefined"
            :title="t('systemStatus.reclaimableSpace')"
            data-testid="reclaimable-space"
          >
            <template #labels>
              <StatusLabel :status="reclaimVisual(status.database.reclaimSuggested)" />
            </template>
            <template #meta>{{ formatBytes(status.database.reclaimableBytes) }}</template>
            <p v-if="status.desktop?.managed" class="system-status__maintenance-meta">
              {{ t("systemStatus.reclaimInApp") }}
            </p>
          </UiBoxRow>
          <UiBoxRow
            v-if="!status.maintenance"
            :title="t('systemStatus.noMaintenanceHistory')"
            :meta="
              t(
                status.desktop?.managed
                  ? 'systemStatus.recentResultsAppearAfterMaintenance'
                  : 'systemStatus.recentResultsAppearAfterRunning',
              )
            "
          />
        </UiBox>
      </template>
    </UiSplitLayout>
  </template>
</template>

<style scoped>
.system-status__stats {
  margin-bottom: var(--space-4);
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

.system-status__row-note {
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

/* A note placed between a box's rows rather than inside one: it takes the rows' own side padding. */
.system-status__box-note {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-top: 1px solid var(--border-muted);
  overflow-wrap: anywhere;
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
</style>

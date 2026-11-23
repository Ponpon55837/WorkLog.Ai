<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Copy, Gauge, Plus, ScanSearch, Trash2, Wrench } from "lucide-vue-next";
import type { UsageRange } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiCheckbox from "../components/ui/UiCheckbox.vue";
import UiDialog from "../components/ui/UiDialog.vue";
import UiDisclosure from "../components/ui/UiDisclosure.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiField from "../components/ui/UiField.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiIconButton from "../components/ui/UiIconButton.vue";
import UiLabel from "../components/ui/UiLabel.vue";
import UiMeter from "../components/ui/UiMeter.vue";
import UiSegmentedControl from "../components/ui/UiSegmentedControl.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import UiStatGrid from "../components/ui/UiStatGrid.vue";
import UiStack from "../components/ui/UiStack.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiTextarea from "../components/ui/UiTextarea.vue";
import { useUsageStore } from "../stores/usage";
import { formatCount, formatMilliseconds, formatPercent } from "../utils/format";
import {
  buildUsageScanRequest,
  canScanUsage,
  MAX_MANUAL_FOLDERS,
  USAGE_TOKEN_KINDS,
  usageProblemMessage,
} from "../utils/usage";
import { t } from "../i18n";

const usageStore = useUsageStore();
const { projects, projectsLoaded, projectsLoading, projectsError, scanResult, scanning, scanError } =
  storeToRefs(usageStore);

const allProjects = ref(false);
const selectedIds = ref<string[]>([]);
const range = ref<UsageRange>("7d");
const since = ref("");
const until = ref("");
const manualFolders = ref<string[]>([]);
const previewOpen = ref(false);
let initialized = false;

const rangeOptions = computed(() => [
  { value: "7d", label: t("usage.range7d") },
  { value: "30d", label: t("usage.range30d") },
  { value: "custom", label: t("usage.rangeCustom") },
]);
const controls = computed(() => ({
  all: allProjects.value,
  projectIds: selectedIds.value,
  range: range.value,
  since: since.value,
  until: until.value,
  manualFolders: manualFolders.value,
}));
const hasSource = computed(() => canScanUsage(controls.value));
const canScan = computed(() => hasSource.value && !scanning.value);
const result = computed(() => scanResult.value);
const isEmpty = computed(() => {
  const value = result.value;
  if (!value) return false;
  const { input, output, cacheRead, cacheCreation } = value.tokens;
  return value.totals.turns === 0 && value.totals.toolCalls === 0 && input + output + cacheRead + cacheCreation === 0;
});
const tokenTotal = computed(() => {
  const value = result.value;
  return value ? value.tokens.input + value.tokens.output + value.tokens.cacheRead + value.tokens.cacheCreation : 0;
});
const costSegments = computed(() => {
  const value = result.value;
  if (!value) return [];
  return USAGE_TOKEN_KINDS.map(({ kind, label, tone }) => ({
    value: value.costShares[kind],
    tone,
    label: t(label),
  }));
});
const costLegend = computed(() => {
  const value = result.value;
  if (!value) return [];
  return USAGE_TOKEN_KINDS.map(({ kind, label, tone }) => ({
    kind,
    tone,
    label: t(label),
    tokens: formatCount(value.tokens[kind]),
    share: formatPercent(value.costShares[kind]),
    multiplier: `×${value.costMultipliers[kind]}`,
  }));
});
const costNote = computed(() => {
  const value = result.value;
  return value
    ? t("usage.costNote", {
        input: value.costMultipliers.input,
        cacheCreation: value.costMultipliers.cacheCreation,
        cacheRead: value.costMultipliers.cacheRead,
        output: value.costMultipliers.output,
      })
    : "";
});
const cacheNote = computed(() => {
  const value = result.value;
  return value
    ? t("usage.cacheNote", {
        reused: value.cache.reused,
        appended: value.cache.appended,
        parsed: value.cache.parsed,
        duration: formatMilliseconds(value.durationMs),
      })
    : "";
});
const problemMessages = computed(() =>
  (result.value?.problems ?? []).map((item) =>
    t("usage.problemItem", {
      project: projects.value.find((project) => project.id === item.projectId)?.name ?? item.projectId,
      message: usageProblemMessage(item.problem),
    }),
  ),
);
const manualFolderItems = computed(() =>
  manualFolders.value.map((_, index) => ({
    index,
    label: t("usage.folderLabel", { index: index + 1 }),
    removeLabel: t("usage.removeFolder", { index: index + 1 }),
  })),
);

function scan(): void {
  if (!canScan.value) return;
  void usageStore.runScan(buildUsageScanRequest(controls.value));
}

function toggleAll(checked: boolean): void {
  allProjects.value = checked;
  if (checked) selectedIds.value = [];
}

function toggleProject(id: string, checked: boolean): void {
  allProjects.value = false;
  selectedIds.value = checked
    ? [...selectedIds.value.filter((value) => value !== id), id]
    : selectedIds.value.filter((value) => value !== id);
}

function addFolder(): void {
  if (manualFolders.value.length < MAX_MANUAL_FOLDERS) manualFolders.value = [...manualFolders.value, ""];
}

function updateFolder(index: number, value: string): void {
  manualFolders.value = manualFolders.value.map((folder, position) => (position === index ? value : folder));
}

function removeFolder(index: number): void {
  manualFolders.value = manualFolders.value.filter((_, position) => position !== index);
}

async function copyPreview(): Promise<void> {
  if (await usageStore.copyForAgent()) previewOpen.value = false;
}

// First open: default to the current project (else all tracked projects) and scan once.
watch(
  projectsLoaded,
  (loaded) => {
    if (!loaded || initialized) return;
    initialized = true;
    const current = projects.value.find((project) => project.current);
    if (current) selectedIds.value = [current.id];
    else allProjects.value = projects.value.length > 0;
    scan();
  },
  { immediate: true },
);

usageStore.setUsageActive(true);
onBeforeUnmount(() => usageStore.setUsageActive(false));
</script>

<template>
  <PageHeader :description="t('usage.description')">
    <template #actions>
      <UiButton :icon="Copy" :disabled="!result" data-testid="usage-copy-for-agent" @click="previewOpen = true">{{
        t("usage.copyForAgent")
      }}</UiButton>
      <UiButton variant="primary" :icon="ScanSearch" :loading="scanning" :disabled="!canScan" @click="scan">{{
        t("usage.scan")
      }}</UiButton>
    </template>
  </PageHeader>

  <UiStack>
    <UiBox data-testid="usage-controls">
      <template #header><UiBoxTitle :icon="Gauge" :title="t('usage.projects')" /></template>
      <UiFlash v-if="projectsError" tone="danger" :title="t('usage.errorTitle')">
        {{ projectsError }}
        <template #actions
          ><UiButton size="sm" @click="usageStore.refreshProjects">{{ t("common.retry") }}</UiButton></template
        >
      </UiFlash>
      <UiSkeleton
        v-else-if="projectsLoading && !projectsLoaded"
        variant="row"
        :count="2"
        :label="t('usage.loadingProjects')"
      />
      <template v-else>
        <UiBoxRow v-if="projects.length > 0">
          <template #leading
            ><UiCheckbox :model-value="allProjects" :label="t('usage.allProjects')" @update:model-value="toggleAll"
          /></template>
          <template #title>{{ t("usage.allProjects") }}</template>
        </UiBoxRow>
        <UiBoxRow v-for="project in projects" :key="project.id" data-testid="usage-project">
          <template #leading
            ><UiCheckbox
              :model-value="selectedIds.includes(project.id)"
              :label="project.name"
              @update:model-value="toggleProject(project.id, $event)"
          /></template>
          <template #title>{{ project.name }}</template>
          <template #labels
            ><UiLabel v-if="project.current" tone="accent">{{ t("usage.currentProject") }}</UiLabel
            ><UiLabel v-if="project.problem" tone="attention">{{
              usageProblemMessage(project.problem)
            }}</UiLabel></template
          >
          <template #meta>{{
            t("usage.sourceCounts", { claude: project.sources.claudeFolders, codex: project.sources.codexFiles })
          }}</template>
        </UiBoxRow>
        <UiEmptyState
          v-if="projects.length === 0"
          compact
          :icon="Gauge"
          :title="t('usage.noProjectsTitle')"
          :description="t('usage.noProjectsDescription')"
        />
      </template>

      <p v-if="!hasSource && projectsLoaded && projects.length > 0" class="usage__hint">
        {{ t("usage.selectProject") }}
      </p>

      <div class="usage__options">
        <UiField :label="t('usage.range')" group>
          <UiSegmentedControl v-model="range" :options="rangeOptions" :label="t('usage.range')" />
        </UiField>
        <template v-if="range === 'custom'">
          <UiField :label="t('usage.since')">
            <UiTextInput v-model="since" type="date" :label="t('usage.since')" />
          </UiField>
          <UiField :label="t('usage.until')">
            <UiTextInput v-model="until" type="date" :label="t('usage.until')" />
          </UiField>
        </template>
      </div>

      <div class="usage__advanced">
        <UiDisclosure :title="t('usage.advancedFolders')" :count="manualFolders.length">
          <p class="usage__hint">{{ t("usage.folderHint", { max: MAX_MANUAL_FOLDERS }) }}</p>
          <div v-for="item in manualFolderItems" :key="item.index" class="usage__folder">
            <UiTextInput
              :model-value="manualFolders[item.index] ?? ''"
              :label="item.label"
              :placeholder="t('usage.folderPlaceholder')"
              mono
              :maxlength="1024"
              @update:model-value="updateFolder(item.index, $event)"
            />
            <UiIconButton :icon="Trash2" :label="item.removeLabel" @click="removeFolder(item.index)" />
          </div>
          <UiButton size="sm" :icon="Plus" :disabled="manualFolders.length >= MAX_MANUAL_FOLDERS" @click="addFolder">{{
            t("usage.addFolder")
          }}</UiButton>
        </UiDisclosure>
      </div>
    </UiBox>

    <UiFlash v-if="scanError" tone="danger" :title="t('usage.errorTitle')" data-testid="usage-error">
      {{ scanError }}
      <template #actions
        ><UiButton size="sm" :disabled="!canScan" @click="scan">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>

    <UiSkeleton v-if="scanning && !result" variant="card" :count="4" :label="t('usage.scanning')" />

    <template v-else-if="result">
      <UiFlash
        v-if="problemMessages.length > 0"
        tone="attention"
        :title="t('usage.problemsTitle')"
        data-testid="usage-problems"
      >
        <ul class="usage__problems">
          <li v-for="message in problemMessages" :key="message">{{ message }}</li>
        </ul>
      </UiFlash>

      <UiEmptyState
        v-if="isEmpty"
        :icon="ScanSearch"
        :title="t('usage.emptyTitle')"
        :description="t('usage.emptyDescription')"
        data-testid="usage-empty"
      />

      <template v-else>
        <UiStatGrid data-testid="usage-summary">
          <UiStatCard
            :label="t('usage.summaryTurns')"
            :value="formatCount(result.totals.turns)"
            :foot="t('usage.summaryTurnsFoot', { sessions: formatCount(result.totals.sessions) })"
          />
          <UiStatCard :label="t('usage.summaryToolCalls')" :value="formatCount(result.totals.toolCalls)" />
          <UiStatCard
            :label="t('usage.summaryShare')"
            :value="formatPercent(result.totals.workIntelligenceShare)"
            :foot="
              t('usage.summaryShareFoot', {
                calls: formatCount(result.totals.workIntelligenceCalls),
                total: formatCount(result.totals.toolCalls),
              })
            "
          />
          <UiStatCard :label="t('usage.summaryTokens')" :value="formatCount(tokenTotal)" />
        </UiStatGrid>

        <UiBox padded data-testid="usage-cost">
          <template #header
            ><UiBoxTitle :title="t('usage.costTitle')"
              ><UiLabel tone="attention">{{ t("usage.estimate") }}</UiLabel></UiBoxTitle
            ></template
          >
          <UiMeter :segments="costSegments" :label="t('usage.costShareLabel')" />
          <ul class="usage__legend">
            <li v-for="item in costLegend" :key="item.kind">
              <span :class="['usage__swatch', `usage__swatch--${item.tone}`]" aria-hidden="true"></span>
              <span class="usage__legend-label">{{ item.label }}</span>
              <span class="usage__num">{{ item.tokens }}</span>
              <span class="usage__num">{{ item.share }}</span>
              <span class="usage__muted usage__num">{{ item.multiplier }}</span>
            </li>
          </ul>
          <p class="usage__hint">{{ costNote }}</p>
        </UiBox>

        <UiBox data-testid="usage-operations">
          <template #header
            ><UiBoxTitle :icon="Wrench" :title="t('usage.operations')" :count="result.operations.length"
          /></template>
          <p v-if="result.operations.length === 0" class="usage__hint">{{ t("usage.operationsEmpty") }}</p>
          <div v-else class="usage__scroll">
            <table class="usage__table">
              <thead>
                <tr>
                  <th scope="col">{{ t("usage.operationKey") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.operationCalls") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.operationsTotalChars") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.operationsAvgChars") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="operation in result.operations" :key="operation.key">
                  <th scope="row">
                    <code>{{ operation.key }}</code>
                  </th>
                  <td class="is-numeric">{{ formatCount(operation.calls) }}</td>
                  <td class="is-numeric">{{ formatCount(operation.resultChars) }}</td>
                  <td class="is-numeric">{{ formatCount(operation.avgChars) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiBox>

        <UiBox data-testid="usage-sessions">
          <template #header><UiBoxTitle :title="t('usage.sessionsTitle')" :count="result.sessions.length" /></template>
          <p v-if="result.sessions.length === 0" class="usage__hint">{{ t("usage.sessionsEmpty") }}</p>
          <UiBoxRow v-for="session in result.sessions" :key="session.label" :title="session.label">
            <template #meta>{{
              t("usage.sessionMeta", {
                turns: formatCount(session.turns),
                toolCalls: formatCount(session.toolCalls),
                tokens: formatCount(
                  session.tokens.input +
                    session.tokens.output +
                    session.tokens.cacheRead +
                    session.tokens.cacheCreation,
                ),
              })
            }}</template>
            <template #trailing
              ><span class="usage__muted">{{
                t("usage.costUnits", { value: formatCount(session.estimatedCostUnits) })
              }}</span></template
            >
          </UiBoxRow>
        </UiBox>

        <UiBox data-testid="usage-other-tools">
          <template #header><UiBoxTitle :title="t('usage.otherTools')" :count="result.otherTools.length" /></template>
          <p v-if="result.otherTools.length === 0" class="usage__hint">{{ t("usage.otherToolsEmpty") }}</p>
          <UiBoxRow v-for="tool in result.otherTools" :key="tool.name">
            <template #title
              ><code>{{ tool.name }}</code></template
            >
            <template #trailing
              ><span class="usage__muted">{{ t("usage.calls", { count: tool.calls }) }}</span></template
            >
          </UiBoxRow>
        </UiBox>

        <p class="usage__hint usage__footnote">{{ cacheNote }}</p>
      </template>
    </template>
  </UiStack>

  <UiDialog
    :open="previewOpen"
    :title="t('usage.copyForAgent')"
    :description="t('usage.previewDescription')"
    size="lg"
    @close="previewOpen = false"
  >
    <UiTextarea
      :model-value="result?.forAgentText ?? ''"
      :rows="14"
      mono
      readonly
      :aria-label="t('usage.previewLabel')"
    />
    <template #footer>
      <UiButton @click="previewOpen = false">{{ t("common.close") }}</UiButton>
      <UiButton variant="primary" :icon="Copy" data-testid="usage-copy-confirm" @click="copyPreview">{{
        t("usage.copyForAgent")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.usage__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  align-items: end;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.usage__advanced {
  padding: 0 var(--space-4) var(--space-4);
}

.usage__folder {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-2);
}

.usage__folder > :first-child {
  flex: 1;
  min-width: 0;
}

.usage__hint {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.usage__footnote {
  padding-inline: 0;
  font-size: var(--text-xs);
}

.usage__problems {
  margin: 0;
  padding-left: var(--space-4);
}

.usage__legend {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0;
  padding: 0;
  list-style: none;
}

.usage__legend li {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto auto auto;
  gap: var(--space-3);
  align-items: center;
  font-size: var(--text-sm);
}

.usage__legend-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.usage__swatch {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-xs);
}

.usage__swatch--accent {
  background: var(--accent);
}

.usage__swatch--attention {
  background: var(--attention);
}

.usage__swatch--success {
  background: var(--success);
}

.usage__swatch--done {
  background: var(--done);
}

.usage__num {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage__scroll {
  max-height: 360px;
  overflow: auto;
  overscroll-behavior: contain;
}

.usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.usage__table th,
.usage__table td {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  white-space: nowrap;
}

.usage__table thead th {
  position: sticky;
  top: 0;
  background: var(--bg-surface);
  color: var(--fg-muted);
  font-weight: 600;
}

.usage__table tbody th {
  font-weight: 400;
}

.usage__table .is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .usage__legend li {
    grid-template-columns: 12px minmax(0, 1fr) auto auto;
  }

  .usage__legend li > :last-child {
    display: none;
  }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Copy, FolderTree, Gauge, Layers, Plus, ScanSearch, Timer, Trash2, TrendingUp, Wrench } from "lucide-vue-next";
import type { UsageProjectItem, UsageRange } from "@work-intelligence/core";
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
import UiStackedBarChart from "../components/ui/UiStackedBarChart.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import UiStatGrid from "../components/ui/UiStatGrid.vue";
import UiStack from "../components/ui/UiStack.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiTextarea from "../components/ui/UiTextarea.vue";
import { useMediaQuery } from "../composables/useMediaQuery";
import { useUsageStore } from "../stores/usage";
import {
  formatCount,
  formatDurationMs,
  formatMilliseconds,
  formatMultiple,
  formatPercent,
  formatTokens,
} from "../utils/format";
import {
  buildUsageScanRequest,
  canScanUsage,
  fillDailyRange,
  MAX_MANUAL_FOLDERS,
  toggleUsageGroup,
  USAGE_TOKEN_TONES,
  usageBlockRows,
  usageComposition,
  usageDayLabel,
  usageModelRows,
  usageProblemMessage,
  usageProjectLayout,
  usageSharedRows,
} from "../utils/usage";
import { t, type MessageKey } from "../i18n";

const TOKEN_KIND_KEYS = {
  input: "usage.tokenInput",
  output: "usage.tokenOutput",
  cacheRead: "usage.tokenCacheRead",
  cacheCreation: "usage.tokenCacheCreation",
} as const satisfies Record<keyof typeof USAGE_TOKEN_TONES, MessageKey>;

const compact = useMediaQuery("(max-width: 639px)");
const usageStore = useUsageStore();
const { projects, projectGroups, projectsLoaded, projectsLoading, projectsError, scanResult, scanning, scanError } =
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
const pickerRows = computed(() => {
  const layout = usageProjectLayout(projects.value, projectGroups.value);
  return [
    ...layout.sections.flatMap((section) => [
      { kind: "group" as const, key: section.key, section },
      ...section.members.map((project) => ({ kind: "project" as const, key: project.id, project })),
    ]),
    ...layout.loose.map((project) => ({ kind: "project" as const, key: project.id, project })),
  ];
});
const sharedRows = computed(() => (result.value ? usageSharedRows(result.value.allocation, projects.value) : []));
const sharedCounts = computed(
  () => new Map(sharedRows.value.flatMap((group) => group.projects.map((entry) => [entry.projectId, entry] as const))),
);
const composition = computed(() => (result.value ? usageComposition(result.value.tokens) : undefined));
const compositionRows = computed(() => {
  const value = composition.value;
  if (!value) return [];
  const rows = [
    {
      id: "counted",
      title: t("usage.compositionCounted"),
      label: t("usage.compositionCountedLabel"),
      row: value.counted,
    },
    { id: "cache", title: t("usage.compositionCache"), label: t("usage.compositionCacheLabel"), row: value.cache },
  ];
  return rows.map(({ id, title, label, row }) => ({
    id,
    title,
    label,
    total: formatTokens(row.total),
    exactTotal: formatCount(row.total),
    segments: row.parts.map((part) => ({
      value: part.value,
      tone: USAGE_TOKEN_TONES[part.kind],
      label: tokenKindLabel(part.kind),
    })),
    parts: row.parts.map((part) => ({
      kind: part.kind,
      tone: USAGE_TOKEN_TONES[part.kind],
      label: tokenKindLabel(part.kind),
      tokens: formatTokens(part.value),
      exact: formatCount(part.value),
      share: formatPercent(part.share),
    })),
  }));
});
const cacheMultiple = computed(() =>
  composition.value?.cacheReadMultiple == null
    ? ""
    : t("usage.cacheReadMultiple", { multiple: formatMultiple(composition.value.cacheReadMultiple) }),
);
const cacheReadFoot = computed(() => {
  const share = result.value?.tokens.cacheReadShare;
  return t("usage.summaryCacheReadFoot", { share: share == null ? "—" : formatPercent(share) });
});
const dailyPoints = computed(() => (result.value ? fillDailyRange(result.value.daily, result.value.range) : []));
const dailyLabels = computed(() => dailyPoints.value.map((point) => usageDayLabel(point.date)));
const dailySeries = computed(() => [
  { name: t("usage.tokenInput"), tone: USAGE_TOKEN_TONES.input, values: dailyPoints.value.map((point) => point.input) },
  {
    name: t("usage.tokenOutput"),
    tone: USAGE_TOKEN_TONES.output,
    values: dailyPoints.value.map((point) => point.output),
  },
]);
const hasDailyUsage = computed(() => (result.value?.daily.length ?? 0) > 0);
const blockRows = computed(() => usageBlockRows(result.value?.blocks ?? []));
const modelRows = computed(() => usageModelRows(result.value?.models ?? []));
const operationRows = computed(() => {
  const operations = result.value?.operations ?? [];
  const highest = Math.max(0, ...operations.map((operation) => operation.calls));
  return operations.map((operation) => ({ ...operation, ratio: highest > 0 ? operation.calls / highest : 0 }));
});
const sessionRows = computed(() => {
  const sessions = result.value?.sessions ?? [];
  const highest = Math.max(0, ...sessions.map((session) => session.primary));
  return sessions.map((session) => ({ ...session, ratio: highest > 0 ? session.primary / highest : 0 }));
});
const otherToolRows = computed(() => {
  const tools = result.value?.otherTools ?? [];
  const highest = Math.max(0, ...tools.map((tool) => tool.calls));
  return tools.map((tool) => ({ ...tool, ratio: highest > 0 ? tool.calls / highest : 0 }));
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

function tokenKindLabel(kind: keyof typeof USAGE_TOKEN_TONES): string {
  return t(TOKEN_KIND_KEYS[kind]);
}

function ratioBar(ratio: number, label: string): { value: number; tone: "accent"; label: string }[] {
  return [{ value: ratio, tone: "accent", label }];
}

function scan(): void {
  if (!canScan.value) return;
  void usageStore.runScan(buildUsageScanRequest(controls.value));
}

function toggleAll(checked: boolean): void {
  allProjects.value = checked;
  if (checked) selectedIds.value = [];
}

function isGroupSelected(ids: readonly string[]): boolean {
  return allProjects.value || ids.every((id) => selectedIds.value.includes(id));
}

function toggleGroup(ids: readonly string[]): void {
  const checked = !isGroupSelected(ids);
  allProjects.value = false;
  selectedIds.value = toggleUsageGroup(selectedIds.value, ids, checked);
}

function allocationText(project: UsageProjectItem): string {
  const entry = sharedCounts.value.get(project.id);
  if (!entry) return "";
  return `${t("usage.allocatedCount", { count: entry.conversations })} · ${t("usage.basisCounts", entry.byBasis)}`;
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
        <template v-for="row in pickerRows" :key="row.key">
          <UiBoxRow v-if="row.kind === 'group'" data-testid="usage-group">
            <template #title>{{ row.section.names }}</template>
            <template #labels
              ><UiLabel tone="accent" :icon="FolderTree">{{ t("usage.groupLabel") }}</UiLabel></template
            >
            <template #meta>{{ t("usage.groupHint") }}</template>
            <template #trailing
              ><UiButton
                size="sm"
                :disabled="allProjects"
                :title="row.section.names"
                data-testid="usage-group-select"
                @click="toggleGroup(row.section.projectIds)"
                >{{
                  isGroupSelected(row.section.projectIds) ? t("usage.groupClear") : t("usage.groupSelect")
                }}</UiButton
              ></template
            >
          </UiBoxRow>
          <UiBoxRow v-else data-testid="usage-project">
            <template #leading
              ><UiCheckbox
                :model-value="selectedIds.includes(row.project.id)"
                :label="row.project.name"
                @update:model-value="toggleProject(row.project.id, $event)"
            /></template>
            <template #title>{{ row.project.name }}</template>
            <template #labels
              ><UiLabel v-if="row.project.current" tone="accent">{{ t("usage.currentProject") }}</UiLabel
              ><UiLabel v-if="row.project.problem" tone="attention">{{
                usageProblemMessage(row.project.problem)
              }}</UiLabel></template
            >
            <template #meta
              >{{
                t("usage.sourceCounts", {
                  claude: row.project.sources.claudeFolders,
                  codex: row.project.sources.codexFiles,
                })
              }}<template v-if="allocationText(row.project)"> · {{ allocationText(row.project) }}</template></template
            >
          </UiBoxRow>
        </template>
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
        <UiStatGrid :columns="3" data-testid="usage-summary">
          <UiStatCard
            :label="t('usage.summaryHeadline')"
            :value="formatTokens(result.tokens.primary)"
            :title="formatCount(result.tokens.primary)"
          />
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
          <UiStatCard
            :label="t('usage.summaryCacheRead')"
            :value="formatTokens(result.tokens.cacheRead)"
            :title="formatCount(result.tokens.cacheRead)"
            :foot="cacheReadFoot"
          />
          <UiStatCard
            :label="t('usage.summaryCacheWrite')"
            :value="formatTokens(result.tokens.cacheCreation)"
            :title="formatCount(result.tokens.cacheCreation)"
            :foot="t('usage.summaryCacheWriteFoot')"
          />
        </UiStatGrid>

        <UiBox v-if="sharedRows.length > 0" data-testid="usage-shared">
          <template #header><UiBoxTitle :icon="FolderTree" :title="t('usage.sharedTitle')" /></template>
          <p class="usage__hint">{{ t("usage.sharedDescription") }}</p>
          <template v-for="group in sharedRows" :key="group.key">
            <UiBoxRow data-testid="usage-unallocated">
              <template #title>{{ t("usage.sharedUnallocated", { projects: group.names }) }}</template>
              <template #labels
                ><UiLabel :tone="group.included ? 'success' : 'attention'">{{
                  group.included ? t("usage.sharedCounted") : t("usage.sharedNotCounted")
                }}</UiLabel></template
              >
              <template #meta>{{
                t("usage.sharedMeta", {
                  conversations: group.conversations,
                  tokens: formatTokens(group.primary),
                })
              }}</template>
            </UiBoxRow>
            <UiBoxRow v-for="entry in group.projects" :key="entry.projectId" data-testid="usage-allocated">
              <template #title>{{ entry.name }}</template>
              <template #labels
                ><UiLabel v-if="!entry.included" tone="neutral">{{ t("usage.sharedNotSelected") }}</UiLabel></template
              >
              <template #meta
                >{{
                  t("usage.sharedMeta", {
                    conversations: entry.conversations,
                    tokens: formatTokens(entry.primary),
                  })
                }}
                · {{ t("usage.basisCounts", entry.byBasis) }}</template
              >
            </UiBoxRow>
          </template>
        </UiBox>

        <div class="usage__row">
          <UiBox v-if="blockRows.length > 0" padded class="usage__area-block" data-testid="usage-blocks">
            <template #header><UiBoxTitle :icon="Timer" :title="t('usage.blockTitle')" /></template>
            <section v-for="block in blockRows" :key="block.agentLabel" class="usage__block">
              <h3 class="usage__subtitle">{{ block.agentLabel }}</h3>
              <dl class="usage__facts">
                <div>
                  <dt>{{ t("usage.blockHeadline") }}</dt>
                  <dd :title="formatCount(block.primary)">{{ formatTokens(block.primary) }}</dd>
                </div>
                <div>
                  <dt>{{ t("usage.blockElapsed") }}</dt>
                  <dd>{{ formatDurationMs(block.elapsedMs) }}</dd>
                </div>
                <div>
                  <dt>{{ t("usage.blockTimeLeft") }}</dt>
                  <dd>{{ formatDurationMs(block.remainingMs) }}</dd>
                </div>
                <div>
                  <dt>{{ t("usage.blockRate") }}</dt>
                  <dd :title="formatCount(block.primaryPerMinute)">{{ formatTokens(block.primaryPerMinute) }}</dd>
                </div>
              </dl>
              <UiMeter
                :max="1"
                :segments="ratioBar(block.progress, t('usage.blockElapsed'))"
                :label="t('usage.blockProgress')"
              />
            </section>
            <p class="usage__note">{{ t("usage.blockRateNote") }}</p>
          </UiBox>

          <UiBox padded class="usage__area-composition" data-testid="usage-composition">
            <template #header><UiBoxTitle :icon="Layers" :title="t('usage.compositionTitle')" /></template>
            <template v-for="(row, index) in compositionRows" :key="row.id">
              <p v-if="index === 1 && cacheMultiple" class="usage__multiple">{{ cacheMultiple }}</p>
              <section class="usage__composition">
                <h3 class="usage__subtitle">
                  {{ row.title }}<span class="usage__subtotal" :title="row.exactTotal">{{ row.total }}</span>
                </h3>
                <UiMeter gap :segments="row.segments" :label="row.label" />
                <table class="usage__legend">
                  <thead class="sr-only">
                    <tr>
                      <th scope="col">{{ t("usage.compositionKind") }}</th>
                      <th scope="col">{{ t("usage.compositionTokens") }}</th>
                      <th scope="col">{{ t("usage.compositionShare") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="part in row.parts" :key="part.kind">
                      <th scope="row">
                        <span :class="['usage__swatch', `usage__swatch--${part.tone}`]" aria-hidden="true"></span
                        >{{ part.label }}
                      </th>
                      <td :title="part.exact">{{ part.tokens }}</td>
                      <td>{{ part.share }}</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </template>
            <p class="usage__note">{{ t("usage.reasoningNote") }}</p>
          </UiBox>

          <UiBox class="usage__area-trend" data-testid="usage-trend">
            <template #header><UiBoxTitle :icon="TrendingUp" :title="t('usage.trendTitle')" /></template>
            <UiStackedBarChart
              v-if="hasDailyUsage"
              :labels="dailyLabels"
              :series="dailySeries"
              :label="t('usage.trendLabel')"
              :format-value="formatTokens"
              :format-exact="formatCount"
              :compact="compact"
            />
            <p v-else class="usage__hint">{{ t("usage.trendEmpty") }}</p>
          </UiBox>
        </div>

        <div class="usage__pair">
          <UiBox data-testid="usage-models">
            <template #header><UiBoxTitle :title="t('usage.modelsTitle')" :count="modelRows.length" /></template>
            <p v-if="modelRows.length === 0" class="usage__hint">{{ t("usage.modelsEmpty") }}</p>
            <table v-else class="usage__table">
              <thead>
                <tr>
                  <th scope="col">{{ t("usage.modelColumn") }}</th>
                  <th scope="col" class="is-numeric is-bar">{{ t("usage.modelHeadline") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.tokenInput") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.tokenOutput") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.tokenCacheRead") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.tokenCacheCreation") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="model in modelRows" :key="model.key">
                  <th scope="row">
                    <span class="usage__name" :title="model.modelLabel">{{ model.modelLabel }}</span>
                    <span class="usage__sub"
                      >{{ model.agentLabel }} · {{ t("usage.modelResponses", { count: model.responses }) }}</span
                    >
                  </th>
                  <td class="is-numeric is-bar" :data-label="t('usage.modelHeadline')">
                    <span :title="formatCount(model.primary)">{{ formatTokens(model.primary) }}</span>
                    <UiMeter
                      size="sm"
                      class="usage__bar"
                      :max="1"
                      :segments="ratioBar(model.ratio, model.modelLabel)"
                    />
                  </td>
                  <td class="is-numeric" :data-label="t('usage.tokenInput')" :title="formatCount(model.tokens.input)">
                    {{ formatTokens(model.tokens.input) }}
                  </td>
                  <td class="is-numeric" :data-label="t('usage.tokenOutput')" :title="formatCount(model.tokens.output)">
                    {{ formatTokens(model.tokens.output) }}
                  </td>
                  <td
                    class="is-numeric"
                    :data-label="t('usage.tokenCacheRead')"
                    :title="formatCount(model.tokens.cacheRead)"
                  >
                    {{ formatTokens(model.tokens.cacheRead) }}
                  </td>
                  <td
                    class="is-numeric"
                    :data-label="t('usage.tokenCacheCreation')"
                    :title="formatCount(model.tokens.cacheCreation)"
                  >
                    {{ formatTokens(model.tokens.cacheCreation) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </UiBox>

          <UiBox data-testid="usage-operations">
            <template #header
              ><UiBoxTitle :icon="Wrench" :title="t('usage.operations')" :count="operationRows.length"
            /></template>
            <p v-if="operationRows.length === 0" class="usage__hint">{{ t("usage.operationsEmpty") }}</p>
            <table v-else class="usage__table">
              <thead>
                <tr>
                  <th scope="col">{{ t("usage.operationKey") }}</th>
                  <th scope="col" class="is-numeric is-bar">{{ t("usage.operationCalls") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.operationsTotalChars") }}</th>
                  <th scope="col" class="is-numeric">{{ t("usage.operationsAvgChars") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="operation in operationRows" :key="operation.key">
                  <th scope="row">
                    <code class="usage__name" :title="operation.key">{{ operation.key }}</code>
                  </th>
                  <td class="is-numeric is-bar" :data-label="t('usage.operationCalls')">
                    <span>{{ formatCount(operation.calls) }}</span>
                    <UiMeter
                      size="sm"
                      class="usage__bar"
                      :max="1"
                      :segments="ratioBar(operation.ratio, operation.key)"
                    />
                  </td>
                  <td class="is-numeric" :data-label="t('usage.operationsTotalChars')">
                    {{ formatCount(operation.resultChars) }}
                  </td>
                  <td class="is-numeric" :data-label="t('usage.operationsAvgChars')">
                    {{ formatCount(operation.avgChars) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </UiBox>
        </div>

        <UiBox data-testid="usage-sessions">
          <template #header><UiBoxTitle :title="t('usage.sessionsTitle')" :count="sessionRows.length" /></template>
          <p v-if="sessionRows.length === 0" class="usage__hint">{{ t("usage.sessionsEmpty") }}</p>
          <table v-else class="usage__table">
            <thead>
              <tr>
                <th scope="col">{{ t("usage.sessionColumn") }}</th>
                <th scope="col" class="is-numeric is-bar">{{ t("usage.modelHeadline") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.summaryTurns") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.summaryToolCalls") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.tokenInput") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.tokenOutput") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.tokenCacheRead") }}</th>
                <th scope="col" class="is-numeric">{{ t("usage.tokenCacheCreation") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="session in sessionRows" :key="session.label">
                <th scope="row">
                  <span class="usage__name">{{ session.label }}</span>
                </th>
                <td class="is-numeric is-bar" :data-label="t('usage.modelHeadline')">
                  <span :title="formatCount(session.primary)">{{ formatTokens(session.primary) }}</span>
                  <UiMeter size="sm" class="usage__bar" :max="1" :segments="ratioBar(session.ratio, session.label)" />
                </td>
                <td class="is-numeric" :data-label="t('usage.summaryTurns')">{{ formatCount(session.turns) }}</td>
                <td class="is-numeric" :data-label="t('usage.summaryToolCalls')">
                  {{ formatCount(session.toolCalls) }}
                </td>
                <td class="is-numeric" :data-label="t('usage.tokenInput')" :title="formatCount(session.tokens.input)">
                  {{ formatTokens(session.tokens.input) }}
                </td>
                <td class="is-numeric" :data-label="t('usage.tokenOutput')" :title="formatCount(session.tokens.output)">
                  {{ formatTokens(session.tokens.output) }}
                </td>
                <td
                  class="is-numeric"
                  :data-label="t('usage.tokenCacheRead')"
                  :title="formatCount(session.tokens.cacheRead)"
                >
                  {{ formatTokens(session.tokens.cacheRead) }}
                </td>
                <td
                  class="is-numeric"
                  :data-label="t('usage.tokenCacheCreation')"
                  :title="formatCount(session.tokens.cacheCreation)"
                >
                  {{ formatTokens(session.tokens.cacheCreation) }}
                </td>
              </tr>
            </tbody>
          </table>
        </UiBox>

        <UiBox data-testid="usage-other-tools">
          <template #header><UiBoxTitle :title="t('usage.otherTools')" :count="otherToolRows.length" /></template>
          <p v-if="otherToolRows.length === 0" class="usage__hint">{{ t("usage.otherToolsEmpty") }}</p>
          <UiBoxRow v-for="tool in otherToolRows" :key="tool.name">
            <template #title
              ><code>{{ tool.name }}</code></template
            >
            <UiMeter size="sm" :max="1" :segments="ratioBar(tool.ratio, tool.name)" />
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

.usage__row,
.usage__pair {
  display: grid;
  gap: var(--space-4);
  align-items: start;
  min-width: 0;
}

.usage__row {
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  grid-template-areas:
    "trend composition"
    "trend block";
}

.usage__pair {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.usage__row > :deep(.ui-box + .ui-box),
.usage__pair > :deep(.ui-box + .ui-box) {
  margin-top: 0;
}

.usage__area-trend {
  grid-area: trend;
}

.usage__area-composition {
  grid-area: composition;
}

.usage__area-block {
  grid-area: block;
}

.usage__subtitle {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  justify-content: space-between;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.usage__subtotal {
  color: var(--fg-muted);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.usage__composition + .usage__composition,
.usage__block + .usage__block {
  margin-top: var(--space-4);
}

.usage__multiple {
  margin: var(--space-3) 0;
  padding: var(--space-2) 0;
  border-block: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.usage__note {
  margin: var(--space-4) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage__legend {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.usage__legend th,
.usage__legend td {
  padding: var(--space-1) 0;
  font-weight: 400;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage__legend th[scope="row"] {
  text-align: left;
}

.usage__legend td:last-child {
  width: 56px;
  color: var(--fg-muted);
}

.usage__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: var(--space-2);
  border-radius: var(--radius-xs);
}

.usage__swatch--accent {
  background: var(--accent);
}

.usage__swatch--done {
  background: var(--done);
}

.usage__swatch--diagram-5 {
  background: var(--diagram-tone-5);
}

.usage__swatch--diagram-6 {
  background: var(--diagram-tone-6);
}

.usage__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: var(--space-2) 0 0;
}

.usage__facts dt {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage__facts dd {
  margin: 0;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.usage__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.usage__table th,
.usage__table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  vertical-align: top;
}

.usage__table thead th,
.usage__table td {
  white-space: nowrap;
}

.usage__table th:first-child,
.usage__table td:first-child {
  padding-left: var(--space-4);
}

.usage__table th:last-child,
.usage__table td:last-child {
  padding-right: var(--space-4);
}

.usage__table tbody tr:last-child > * {
  border-bottom: 0;
}

.usage__table thead th {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.usage__table tbody th {
  min-width: 0;
  font-weight: 400;
}

.usage__table .is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage__table .is-bar {
  min-width: 96px;
}

.usage__table .usage__bar {
  margin-top: var(--space-1);
}

.usage__name {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage__sub {
  display: block;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 959px) {
  .usage__row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "block"
      "composition"
      "trend";
  }

  .usage__pair {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 639px) {
  .usage__table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .usage__table,
  .usage__table tbody,
  .usage__table tr,
  .usage__table th {
    display: block;
  }

  .usage__table tr {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .usage__table tbody tr:last-child {
    border-bottom: 0;
  }

  .usage__table th,
  .usage__table td,
  .usage__table th:first-child,
  .usage__table td:first-child,
  .usage__table th:last-child,
  .usage__table td:last-child {
    padding: 0;
    border: 0;
  }

  .usage__table tbody th {
    margin-bottom: var(--space-1);
    font-weight: 600;
  }

  .usage__name {
    max-width: none;
  }

  .usage__table td {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 var(--space-3);
    padding: 2px 0;
  }

  .usage__table td::before {
    content: attr(data-label);
    text-align: left;
    color: var(--fg-muted);
  }

  .usage__table .is-bar {
    min-width: 0;
  }

  .usage__table .usage__bar {
    grid-column: 1 / -1;
  }
}
</style>

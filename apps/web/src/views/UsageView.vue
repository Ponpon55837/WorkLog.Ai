<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Copy, ScanSearch } from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import UsageBreakdowns from "../components/domain/UsageBreakdowns.vue";
import UsageComposition from "../components/domain/UsageComposition.vue";
import UsageControls from "../components/domain/UsageControls.vue";
import UsageShared from "../components/domain/UsageShared.vue";
import UsageSummary from "../components/domain/UsageSummary.vue";
import UsageTrend from "../components/domain/UsageTrend.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiDialog from "../components/ui/UiDialog.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStack from "../components/ui/UiStack.vue";
import UiTextarea from "../components/ui/UiTextarea.vue";
import { useUsageStore } from "../stores/usage";
import { formatMilliseconds } from "../utils/format";
import { buildUsageScanRequest, canScanUsage, usageProblemMessage, type UsageScanControls } from "../utils/usage";
import { t } from "../i18n";

const usageStore = useUsageStore();
const { projects, projectById, projectsLoaded, scanResult: result, scanning, scanError } = storeToRefs(usageStore);

const controls = ref<UsageScanControls>({
  all: false,
  projectIds: [],
  range: "7d",
  since: "",
  until: "",
  manualFolders: [],
});
const previewOpen = ref(false);
let initialized = false;

const canScan = computed(() => canScanUsage(controls.value) && !scanning.value);
const isEmpty = computed(() => {
  const value = result.value;
  if (!value) return false;
  const { input, output, cacheRead, cacheCreation } = value.tokens;
  return value.totals.turns === 0 && value.totals.toolCalls === 0 && input + output + cacheRead + cacheCreation === 0;
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
      project: projectById.value.get(item.projectId)?.name ?? item.projectId,
      message: usageProblemMessage(item.problem),
    }),
  ),
);

function scan(): void {
  if (!canScan.value) return;
  void usageStore.runScan(buildUsageScanRequest(controls.value));
}

async function copyPreview(): Promise<void> {
  if (await usageStore.copyForAgent()) previewOpen.value = false;
}

watch(
  projectsLoaded,
  (loaded) => {
    if (!loaded || initialized) return;
    initialized = true;
    const current = projects.value.find((project) => project.current);
    controls.value = current
      ? { ...controls.value, projectIds: [current.id] }
      : { ...controls.value, all: projects.value.length > 0 };
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
    </template>
  </PageHeader>

  <div class="usage">
    <div class="usage__layout">
      <UsageControls v-model="controls" class="usage__controls" @scan="scan" />

      <UiStack class="usage__results">
        <UiFlash v-if="scanError" tone="danger" :title="t('usage.errorTitle')" data-testid="usage-error">
          {{ scanError }}
          <template #actions
            ><UiButton size="sm" :disabled="!canScan" @click="scan">{{ t("common.retry") }}</UiButton></template
          >
        </UiFlash>

        <template v-if="scanning && !result">
          <UiSkeleton variant="card" :count="2" :label="t('usage.scanning')" />
          <UiSkeleton variant="card" :count="4" quiet />
          <UiSkeleton variant="card" :count="2" quiet />
        </template>

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
            <UsageSummary />
            <UsageShared />
            <div class="usage__charts">
              <UsageTrend />
              <UsageComposition />
            </div>
            <UsageBreakdowns />
            <p class="usage__footnote">{{ cacheNote }}</p>
          </template>
        </template>
      </UiStack>
    </div>
  </div>

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
/* The page width, not the viewport, decides whether the controls get a side column, so the sidebar's width is accounted for. */
.usage {
  container: usage-page / inline-size;
}

.usage__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

/* The results column is the container the cards inside size against, so a narrow column stacks them even on a wide screen. */
.usage__results {
  container: usage-results / inline-size;
}

.usage__charts {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  min-width: 0;
}

.usage__charts > :deep(.ui-box + .ui-box) {
  margin-top: 0;
}

.usage__problems {
  margin: 0;
  padding-left: var(--space-4);
}

.usage__footnote {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@container usage-results (min-width: 720px) {
  .usage__charts {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  }
}

@container usage-page (min-width: 1080px) {
  .usage__layout {
    grid-template-columns: 300px minmax(0, 1fr);
  }

  /* Only the results scroll; the controls stay in view so switching projects or the range needs no scrolling back.
     The height leaves room for the one-row page header above it, so the scan button is whole before any scrolling. */
  .usage__controls {
    position: sticky;
    top: var(--space-4);
    height: calc(100vh - var(--header-height) - var(--space-16) - var(--space-6));
    overflow-y: auto;
  }
}
</style>

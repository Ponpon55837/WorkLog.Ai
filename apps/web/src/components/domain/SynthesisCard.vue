<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";
import { History, RefreshCw, RotateCcw, Sparkles, Trash2, X } from "lucide-vue-next";
import type { WorkReportPeriod, ReportSummary } from "@work-intelligence/core";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { useToast } from "../../composables/useToast";
import { reportSynthesisInstruction, useReportsStore } from "../../stores/reports";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate, formatRelative } from "../../utils/format";
import { requestStatus } from "../../utils/status";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCommandBlock from "../ui/UiCommandBlock.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import StatusLabel from "./StatusLabel.vue";
import SynthesisBlock from "./SynthesisBlock.vue";
import { t } from "../../i18n";

/**
 * Agent-written report synthesis. Section order and headings follow the ReportSummary contract in
 * docs/work-record-and-report-format.md; numbers shown elsewhere on the page never come from here.
 */
const reportsStore = useReportsStore();
const {
  report,
  reportPeriod,
  reportDate,
  reportRange,
  reportProjectId,
  reportSynthesisRequest: request,
  reportSynthesisSummary: summary,
  reportSynthesisHistory: history,
  reportSynthesisLoading,
  reportSynthesisCreating,
  reportSynthesisRetrying,
  reportSynthesisCancelling,
  reportSynthesisError,
  reportSynthesisIsActive: isActive,
  reportSynthesisCanRetry: canRetry,
} = storeToRefs(reportsStore);
const {
  loadReportSynthesis,
  refreshReportSynthesis,
  selectReportSynthesisVersion,
  createReportSynthesisRequest,
  retryReportSynthesisRequest,
  cancelReportSynthesisRequest,
  deleteReportSynthesisVersion,
} = reportsStore;
const sessionsStore = useSessionsStore();
const { openSessionDetail, setSessionSequence } = sessionsStore;
const { showToast } = useToast();

useActiveRequestWatch({
  requests: () => (request.value ? [request.value] : []),
  check: refreshReportSynthesis,
  scope: () =>
    `${reportPeriod.value}|${reportDate.value}|${reportRange.value.from}|${reportRange.value.to}|${reportProjectId.value}`,
  onSettled: (_request, status) => {
    if (status === "completed") {
      showToast(t("reports.theAgentFinishedTheAi"), "success");
    } else if (status === "failed") {
      showToast(t("reports.theAiReportSynthesisDid"), "danger");
    }
  },
});

const grainHints: Record<WorkReportPeriod, string> = {
  day: t("reports.dailyReportGroupedByTask"),
  week: t("reports.weeklyReportGroupedByFeature"),
  month: t("reports.monthlyReportGroupedByProject"),
  quarter: t("reports.quarterlyReportGroupedByInitiative"),
  year: t("reports.annualReportGroupedByMajor"),
  custom: t("reports.customRangeGroupedByWork"),
};

const sections = computed(() => {
  const current = summary.value;
  if (!current) {
    return [];
  }
  return [
    { key: "themes", title: t("reports.theme"), hint: grainHints[current.period], blocks: current.themes },
    { key: "highlights", title: t("reports.keyOutcomes"), blocks: current.highlights },
    { key: "verification", title: t("common.verification"), blocks: current.verification },
    { key: "comparison", title: t("reports.compare"), blocks: current.comparison },
    { key: "risks", title: t("reports.risksAndLimits"), blocks: current.risks },
    { key: "decisions", title: t("common.decisions"), blocks: current.decisions },
    { key: "nextSteps", title: t("common.statusOpenItems"), blocks: current.nextSteps },
  ].filter((section) => section.blocks.length > 0);
});

const pendingMessage = computed(() => {
  const status = request.value?.status;
  if (status === "pending") {
    return t("reports.pasteTheInstructionBelowInto");
  }
  if (status === "processing") {
    return t("reports.theAgentHasStartedThe");
  }
  if (status === "failed" || status === "cancelled") {
    return t("reports.thisCleanupDidNotFinish");
  }
  return t("reports.thisReportHasNoAi");
});

function openSources(sessionIds: string[]): void {
  setSessionSequence(sessionIds);
  void openSessionDetail(sessionIds[0]);
}

function versionMeta(version: ReportSummary): string {
  return `${formatRelative(version.createdAt)} · ${version.generatedByAgent}${version.isCurrent ? t("reports.currentVersion") : ""}`;
}
</script>

<template>
  <UiBox data-testid="report-synthesis">
    <template #header>
      <UiBoxTitle :icon="Sparkles" eyebrow="AI synthesis" :title="summary?.title ?? t('reports.aiReportSynthesis')">
        <StatusLabel v-if="request" :status="requestStatus[request.status]" />
      </UiBoxTitle>
      <UiIconButton
        :icon="RefreshCw"
        :label="t('reports.refreshCleanupStatus')"
        size="sm"
        :loading="reportSynthesisLoading"
        @click="loadReportSynthesis"
      />
    </template>

    <div class="synthesis">
      <UiFlash v-if="reportSynthesisError" tone="danger">{{ reportSynthesisError }}</UiFlash>
      <UiSkeleton v-if="reportSynthesisLoading && !summary && !request" variant="text" :count="3" />

      <div v-if="!summary || isActive || canRetry" class="synthesis__pending">
        <p>{{ pendingMessage }}</p>
        <p v-if="request?.failureReason" class="synthesis__failure">{{ request.failureReason }}</p>
        <p v-if="summary && isActive" class="synthesis__note">{{ t("reports.thePreviousSynthesisIsKept") }}</p>
        <UiCommandBlock
          v-if="isActive"
          :text="reportSynthesisInstruction()"
          :success-message="t('reports.naturalLanguageSynthesisInstructionCopied')"
        />
        <div class="synthesis__actions">
          <UiButton
            v-if="canRetry"
            variant="primary"
            :icon="RotateCcw"
            :loading="reportSynthesisRetrying"
            @click="retryReportSynthesisRequest"
            >{{ t("reports.retryThisCleanup") }}</UiButton
          >
          <UiButton
            v-else-if="!isActive"
            variant="primary"
            :icon="Sparkles"
            :loading="reportSynthesisCreating"
            :disabled="!report"
            @click="createReportSynthesisRequest"
          >
            {{ summary ? t("reports.reSynthesizeThisReport") : t("reports.askAgentToSynthesizeThis") }}
          </UiButton>
          <UiButton
            v-if="isActive"
            variant="danger"
            :icon="X"
            :loading="reportSynthesisCancelling"
            @click="cancelReportSynthesisRequest"
            >{{ t("reports.cancelThisCleanup") }}</UiButton
          >
        </div>
      </div>

      <template v-if="summary">
        <p class="synthesis__executive">{{ summary.executiveSummary }}</p>
        <SynthesisBlock
          v-for="section in sections"
          :key="section.key"
          :title="section.title"
          :hint="section.hint"
          :blocks="section.blocks"
          @open-sources="openSources"
        />
        <div class="synthesis__footer">
          <UiLabel>{{ t("reports.sourceSessions", { length: summary.sourceSessionIds.length }) }}</UiLabel>
          <UiLabel
            >{{ summary.generatedByAgent
            }}<template v-if="summary.generatedByModel"> · {{ summary.generatedByModel }}</template></UiLabel
          >
          <UiLabel>prompt {{ summary.promptVersion }}</UiLabel>
          <time :datetime="summary.createdAt" :title="formatDate(summary.createdAt)">{{
            formatRelative(summary.createdAt)
          }}</time>
          <UiButton
            v-if="!isActive && !canRetry"
            class="synthesis__rerun"
            size="sm"
            :icon="Sparkles"
            :loading="reportSynthesisCreating"
            @click="createReportSynthesisRequest"
            >{{ t("common.refresh") }}</UiButton
          >
        </div>
        <UiDisclosure
          v-if="history.length > 1"
          :icon="History"
          :title="t('reports.pastVersions')"
          :count="history.length"
          data-testid="report-synthesis-history"
        >
          <VirtualList
            class="synthesis__versions"
            :items="history"
            :enabled="true"
            :estimate-item-height="64"
            max-height="min(28vh, 240px)"
            :label="t('reports.reportSynthesisVersionList')"
          >
            <template #default="{ item: version }">
              <div
                class="synthesis__version-row"
                data-testid="report-synthesis-version"
                :class="{ 'is-selected': version.id === summary.id }"
              >
                <button
                  type="button"
                  class="synthesis__version"
                  :aria-pressed="version.id === summary.id"
                  @click="selectReportSynthesisVersion(version)"
                >
                  <strong>{{ version.title }}</strong>
                  <small>{{ versionMeta(version) }}</small>
                </button>
                <UiIconButton
                  v-if="!version.isCurrent"
                  :icon="Trash2"
                  :label="t('reports.removeVersion', { title: version.title })"
                  size="sm"
                  variant="danger"
                  @click="deleteReportSynthesisVersion(version)"
                />
              </div>
            </template>
          </VirtualList>
        </UiDisclosure>
      </template>
    </div>
  </UiBox>
</template>

<style scoped>
.synthesis {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
}

.synthesis__pending {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.synthesis__failure {
  color: var(--danger);
}

.synthesis__note {
  color: var(--fg-muted);
}

.synthesis__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.synthesis__executive {
  color: var(--fg);
  font-size: var(--text-lg);
  line-height: 1.6;
}

.synthesis__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.synthesis__rerun {
  margin-left: auto;
}

.synthesis__versions {
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
}

.synthesis__versions :deep(.virtual-list-item + .virtual-list-item) {
  border-top: 1px solid var(--border-muted);
}

.synthesis__version-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.synthesis__version-row.is-selected {
  box-shadow: inset 2px 0 0 var(--accent);
}

.synthesis__version {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg);
  text-align: left;
}

.synthesis__version small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>

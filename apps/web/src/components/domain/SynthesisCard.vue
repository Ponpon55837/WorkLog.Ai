<script setup lang="ts">
import { computed } from "vue";
import { History, RefreshCw, RotateCcw, Sparkles, Trash2, X } from "lucide-vue-next";
import type { WorkReportPeriod, ReportSummary } from "@work-intelligence/core";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { reportSynthesisInstruction, useReports } from "../../composables/useReports";
import { useSessionDetail } from "../../composables/useSessionDetail";
import { useToast } from "../../composables/useToast";
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

/**
 * Agent-written report synthesis. Section order and headings follow the ReportSummary contract in
 * docs/work-record-and-report-format.md; numbers shown elsewhere on the page never come from here.
 */
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
  loadReportSynthesis,
  refreshReportSynthesis,
  selectReportSynthesisVersion,
  createReportSynthesisRequest,
  retryReportSynthesisRequest,
  cancelReportSynthesisRequest,
  deleteReportSynthesisVersion,
} = useReports();
const { openSessionDetail, setSessionSequence } = useSessionDetail();
const { showToast } = useToast();

useActiveRequestWatch({
  requests: () => (request.value ? [request.value] : []),
  check: refreshReportSynthesis,
  scope: () =>
    `${reportPeriod.value}|${reportDate.value}|${reportRange.value.from}|${reportRange.value.to}|${reportProjectId.value}`,
  onSettled: (_request, status) => {
    if (status === "completed") {
      showToast("Agent 已完成 AI 報告整理。", "success");
    } else if (status === "failed") {
      showToast("AI 報告整理沒有完成，可以重試。", "danger");
    }
  },
});

const grainHints: Record<WorkReportPeriod, string> = {
  day: "日報 · 以 Task / Feature / Issue 分組",
  week: "週報 · 以 Feature / Workstream 分組",
  month: "月報 · 以 Project / Milestone 分組",
  quarter: "季報 · 以 Initiative 分組",
  year: "年報 · 以 Major Contribution 分組",
  custom: "自訂期間 · 依工作主題整理",
};

const sections = computed(() => {
  const current = summary.value;
  if (!current) {
    return [];
  }
  return [
    { key: "themes", title: "主題", hint: grainHints[current.period], blocks: current.themes },
    { key: "highlights", title: "重點成果", blocks: current.highlights },
    { key: "verification", title: "驗證", blocks: current.verification },
    { key: "comparison", title: "比較", blocks: current.comparison },
    { key: "risks", title: "風險與限制", blocks: current.risks },
    { key: "decisions", title: "決策", blocks: current.decisions },
    { key: "nextSteps", title: "狀態／未結項", blocks: current.nextSteps },
  ].filter((section) => section.blocks.length > 0);
});

const pendingMessage = computed(() => {
  const status = request.value?.status;
  if (status === "pending") {
    return "請在目前的 Codex 或 Claude 對話中貼上下面的指令，Agent 會處理這份報告。";
  }
  if (status === "processing") {
    return "Agent 已開始處理；完成後這裡會自動顯示新版本。";
  }
  if (status === "failed" || status === "cancelled") {
    return "這次整理沒有完成，可以重試建立一次安全的整理請求。";
  }
  return "這份報告還沒有 AI 整理。建立請求後，WorkLog 只會記錄待處理請求，不會主動呼叫任何 Agent。";
});

function openSources(sessionIds: string[]): void {
  setSessionSequence(sessionIds);
  void openSessionDetail(sessionIds[0]);
}

function versionMeta(version: ReportSummary): string {
  return `${formatRelative(version.createdAt)} · ${version.generatedByAgent}${version.isCurrent ? " · 目前版本" : ""}`;
}
</script>

<template>
  <UiBox data-testid="report-synthesis">
    <template #header>
      <UiBoxTitle :icon="Sparkles" eyebrow="AI synthesis" :title="summary?.title ?? 'AI 報告整理'">
        <StatusLabel v-if="request" :status="requestStatus[request.status]" />
      </UiBoxTitle>
      <UiIconButton
        :icon="RefreshCw"
        label="重新整理整理狀態"
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
        <p v-if="summary && isActive" class="synthesis__note">上一版整理仍保留，新的整理完成後才會替換。</p>
        <UiCommandBlock v-if="isActive" :text="reportSynthesisInstruction" success-message="已複製自然語言整理指令。" />
        <div class="synthesis__actions">
          <UiButton
            v-if="canRetry"
            variant="primary"
            :icon="RotateCcw"
            :loading="reportSynthesisRetrying"
            @click="retryReportSynthesisRequest"
            >重試這次整理</UiButton
          >
          <UiButton
            v-else-if="!isActive"
            variant="primary"
            :icon="Sparkles"
            :loading="reportSynthesisCreating"
            :disabled="!report"
            @click="createReportSynthesisRequest"
          >
            {{ summary ? "重新整理這份報告" : "請 Agent 整理這份報告" }}
          </UiButton>
          <UiButton
            v-if="isActive"
            variant="danger"
            :icon="X"
            :loading="reportSynthesisCancelling"
            @click="cancelReportSynthesisRequest"
            >取消這次整理</UiButton
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
          <UiLabel>{{ summary.sourceSessionIds.length }} 個來源 Session</UiLabel>
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
            >重新整理</UiButton
          >
        </div>
        <UiDisclosure
          v-if="history.length > 1"
          :icon="History"
          title="歷史版本"
          :count="history.length"
          data-testid="report-synthesis-history"
        >
          <VirtualList
            class="synthesis__versions"
            :items="history"
            :enabled="true"
            :estimate-item-height="64"
            max-height="min(28vh, 240px)"
            label="報表整理歷史版本清單"
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
                  :label="`移除歷史版本 ${version.title}`"
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

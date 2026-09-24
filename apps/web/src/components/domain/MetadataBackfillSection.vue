<script setup lang="ts">
import { computed } from "vue";
import { CircleCheckBig, RefreshCw, ScanSearch, X } from "lucide-vue-next";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { metadataBackfillInstruction, useMetadataBackfill } from "../../composables/useMetadataBackfill";
import { useToast } from "../../composables/useToast";
import { formatDate, formatRelative } from "../../utils/format";
import { metadataGapsOf, metadataGapStatus, requestStatus, verificationStatus } from "../../utils/status";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCommandBlock from "../ui/UiCommandBlock.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import StatusLabel from "./StatusLabel.vue";

/**
 * Metadata gap scan and the Agent request. The UI only reads stored metadata and creates
 * requests; it never writes guessed changed files or verification.
 */
const {
  metadataBackfillPreview: preview,
  metadataBackfillLoading,
  metadataBackfillError,
  metadataBackfillRequest: request,
  metadataBackfillRequestIsActive,
  metadataBackfillRequestLoading,
  metadataBackfillRequestCreating,
  metadataBackfillRequestError,
  loadMetadataBackfillRequest,
  refreshMetadataBackfillRequest,
  createMetadataBackfillRequest,
  cancelMetadataBackfillRequest,
  previewMetadataBackfill,
  openMetadataBackfillSession,
} = useMetadataBackfill();
const { showToast } = useToast();

useActiveRequestWatch({
  requests: () => (request.value ? [request.value] : []),
  check: refreshMetadataBackfillRequest,
  onSettled: (_request, status) => {
    if (status === "completed") {
      showToast("Agent 已完成 metadata 回補。", "success");
      // The gap list is a separate scan; rerun it so resolved gaps disappear.
      void previewMetadataBackfill();
    } else if (status === "failed") {
      showToast("metadata 回補沒有完成。", "danger");
    }
  },
});

const requestMessage = computed(() => {
  if (!request.value) {
    return "";
  }
  if (metadataBackfillRequestIsActive.value) {
    return "在目前的 Codex 或 Claude 對話中貼上下面的指令。Agent 會取得待回補清單、檢查 tracked 專案的 worktree／handoff，只寫回已確認的 metadata。";
  }
  if (request.value.status === "completed") {
    return "這批 metadata 已完成回補。重新掃描後，若仍有缺口會建立新的請求。";
  }
  return preview.value?.items.length
    ? "這批 metadata 回補尚未完成，可以重新建立請求後再請 Agent 處理。"
    : "這批 metadata 回補尚未完成。重新掃描後，若仍有缺口即可建立新的請求。";
});
</script>

<template>
  <div class="backfill">
    <UiFlash v-if="metadataBackfillError" tone="danger">{{ metadataBackfillError }}</UiFlash>
    <UiFlash v-if="metadataBackfillRequestError" tone="danger">{{ metadataBackfillRequestError }}</UiFlash>

    <UiBox v-if="request" padded>
      <template #header>
        <UiBoxTitle eyebrow="Agent request" title="請 Agent 回補 metadata" />
        <div class="backfill__request-actions">
          <StatusLabel :status="requestStatus[request.status]" />
          <UiIconButton
            :icon="RefreshCw"
            label="重新整理回補狀態"
            size="sm"
            :loading="metadataBackfillRequestLoading"
            @click="loadMetadataBackfillRequest"
          />
        </div>
      </template>
      <p class="backfill__message">{{ requestMessage }}</p>
      <UiCommandBlock
        v-if="metadataBackfillRequestIsActive"
        :text="metadataBackfillInstruction"
        success-message="已複製自然語言 metadata 回補指令。"
      />
      <div class="backfill__buttons">
        <UiButton
          v-if="metadataBackfillRequestIsActive"
          variant="danger"
          size="sm"
          :icon="X"
          :disabled="metadataBackfillRequestLoading"
          @click="cancelMetadataBackfillRequest"
          >取消回補</UiButton
        >
        <UiButton
          v-else-if="preview?.items.length"
          size="sm"
          :loading="metadataBackfillRequestCreating"
          @click="createMetadataBackfillRequest"
          >重新建立回補請求</UiButton
        >
      </div>
    </UiBox>
    <UiFlash v-else-if="preview?.items.length" tone="attention" title="這些缺口需要 Agent 確認">
      掃描結果不會自行猜測檔案或驗證狀態；建立請求後，Agent 才能在目前對話中檢查並回寫。
      <template #actions
        ><UiButton
          variant="primary"
          size="sm"
          :loading="metadataBackfillRequestCreating"
          @click="createMetadataBackfillRequest"
          >請 Agent 回補</UiButton
        ></template
      >
    </UiFlash>

    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle eyebrow="Agent follow-ups" title="需要回補的 Session" :count="preview?.items.length" />
        <UiButton size="sm" :icon="ScanSearch" :loading="metadataBackfillLoading" @click="previewMetadataBackfill">{{
          preview ? "重新掃描" : "掃描 metadata 缺口"
        }}</UiButton>
      </template>
      <UiEmptyState
        v-if="!preview"
        compact
        :icon="ScanSearch"
        title="尚未掃描"
        description="掃描只讀取中央 SQLite 中已保存的 Session metadata，不會讀取專案檔案。"
      />
      <template v-else>
        <div class="backfill__stats">
          <UiStatCard
            label="需要回補"
            :value="preview.totals.needsBackfill"
            :value-tone="preview.totals.needsBackfill ? 'attention' : undefined"
          />
          <UiStatCard
            :label="metadataGapStatus.changed_files.label"
            :icon="metadataGapStatus.changed_files.icon"
            :value="preview.totals.changedFilesMissing"
          />
          <UiStatCard
            :label="metadataGapStatus.verification_missing.label"
            :icon="metadataGapStatus.verification_missing.icon"
            :value="preview.totals.verificationMissing"
          />
          <UiStatCard
            :label="metadataGapStatus.verification_not_run.label"
            :icon="metadataGapStatus.verification_not_run.icon"
            :value="preview.totals.verificationNotRun"
          />
        </div>
        <UiEmptyState
          v-if="!preview.items.length"
          compact
          :icon="CircleCheckBig"
          title="目前沒有待回補資料"
          description="所有 tracked Session 都已提供必要的結構化 metadata。"
        />
        <UiBoxRow
          v-for="item in preview.items"
          :key="item.sessionId"
          clickable
          :title="item.title"
          @select="openMetadataBackfillSession(item)"
        >
          <template #labels>
            <StatusLabel v-for="gap in metadataGapsOf(item)" :key="gap" :status="metadataGapStatus[gap]" />
          </template>
          <template #meta>
            {{ item.projectName }} ·
            <time :title="formatDate(item.completedAt)">{{ formatRelative(item.completedAt) }}</time> ·
            {{ item.changedFilesCount }} 個檔案 · {{ item.rawSnapshotCount }} 份 handoff snapshot
          </template>
          <template #trailing
            ><StatusLabel class="hide-sm" :status="verificationStatus[item.verificationStatus]" :show-icon="false"
          /></template>
        </UiBoxRow>
        <p v-if="preview.truncated" class="backfill__note">結果已達顯示上限，其餘 Session 會由 Agent 分頁檢查。</p>
      </template>
    </UiBox>
  </div>
</template>

<style scoped>
.backfill {
  display: grid;
  gap: var(--space-4);
}

.backfill > .ui-box + .ui-box {
  margin-top: 0;
}

.backfill__request-actions,
.backfill__buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.backfill__buttons:empty {
  display: none;
}

.backfill__message {
  margin-bottom: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.backfill__buttons {
  margin-top: var(--space-3);
}

.backfill__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.backfill__note {
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 959px) {
  .backfill__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

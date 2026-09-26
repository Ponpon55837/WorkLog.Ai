<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { FileText } from "lucide-vue-next";
import type { HandoffImportPreviewItem } from "@work-intelligence/core";
import { useHandoffImportStore } from "../../stores/handoff-import";
import { verificationStatus } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import VirtualList from "../VirtualList.vue";
import StatusLabel from "./StatusLabel.vue";

/** Import confirmation: shows what will be imported and what is excluded, with reasons. */
const handoffImportStore = useHandoffImportStore();
const { handoffImportPreview, handoffImportApplying, handoffImportError, importableHandoffs, selectedHandoffCount } =
  storeToRefs(handoffImportStore);
const {
  isHandoffSelected,
  toggleHandoffSelection,
  selectAllHandoffs,
  clearHandoffSelection,
  handoffDecisionLabel,
  closeHandoffImport,
  applyHandoffImport,
} = handoffImportStore;

const description = computed(() =>
  handoffImportPreview.value
    ? `${handoffImportPreview.value.project.name} · ${handoffImportPreview.value.handoffDirectory}`
    : "",
);

function decisionTone(item: HandoffImportPreviewItem): "success" | "neutral" | "attention" | "danger" {
  if (item.decision === "eligible") {
    return "success";
  }
  if (item.decision === "error") {
    return "danger";
  }
  return item.decision === "already_imported" ? "neutral" : "attention";
}

function filesText(item: HandoffImportPreviewItem): string {
  if (item.changedFilesStatus === "detected") {
    return `${item.changedFiles.length} 個檔案`;
  }
  return item.changedFilesStatus === "not_found" ? "尚未找到檔案 metadata" : "未讀取檔案 metadata";
}
</script>

<template>
  <UiDialog
    :open="Boolean(handoffImportPreview)"
    title="歷史 handoff 匯入預覽"
    :description="description"
    size="lg"
    :busy="handoffImportApplying"
    @close="closeHandoffImport"
  >
    <template v-if="handoffImportPreview">
      <p class="handoff__intro">
        只有明確標示完成的文件可匯入；blocked、pending、僅規劃與缺少完成狀態的文件會列出原因但不會建立 Session。
      </p>
      <UiFlash v-if="handoffImportError" tone="danger">{{ handoffImportError }}</UiFlash>
      <div class="handoff__stats">
        <UiStatCard label="發現" :value="handoffImportPreview.totals.discovered" />
        <UiStatCard label="可匯入" :value="handoffImportPreview.totals.eligible" value-tone="success" />
        <UiStatCard label="已匯入" :value="handoffImportPreview.totals.alreadyImported" />
        <UiStatCard
          label="略過／錯誤"
          :value="handoffImportPreview.totals.excluded + handoffImportPreview.totals.errors"
        />
      </div>
      <UiEmptyState
        v-if="!handoffImportPreview.directoryFound"
        compact
        :icon="FileText"
        title="找不到 handoff 目錄"
        :description="`${handoffImportPreview.handoffDirectory} 不存在或沒有可讀取的 Markdown 文件。`"
      />
      <VirtualList
        v-else
        class="handoff__list"
        :items="handoffImportPreview.items"
        :enabled="true"
        :estimate-item-height="128"
        max-height="min(56vh, 560px)"
        label="Handoff 匯入預覽清單"
      >
        <template #default="{ item }">
          <label :class="['handoff__item', { 'is-disabled': item.decision !== 'eligible' }]">
            <input
              type="checkbox"
              :checked="isHandoffSelected(item.sourcePath)"
              :disabled="item.decision !== 'eligible' || handoffImportApplying"
              @change="toggleHandoffSelection(item)"
            />
            <span class="handoff__copy">
              <span class="handoff__title">
                <strong>{{ item.title }}</strong>
                <UiLabel :tone="decisionTone(item)">{{ handoffDecisionLabel(item) }}</UiLabel>
                <StatusLabel v-if="item.verificationStatus" :status="verificationStatus[item.verificationStatus]" />
              </span>
              <code>{{ item.sourcePath }}</code>
              <span v-if="item.summaryPreview" class="handoff__summary">{{ item.summaryPreview }}</span>
              <small>
                <template v-if="item.recordedDate">記錄日期 {{ item.recordedDate }} · </template>{{ filesText(item)
                }}<template v-if="item.detail"> · {{ item.detail }}</template>
              </small>
            </span>
          </label>
        </template>
      </VirtualList>
    </template>
    <template #footer>
      <span class="handoff__selection">
        已選取 {{ selectedHandoffCount }} 個<template v-if="handoffImportPreview?.truncated">
          · 已達檔案上限，預覽被截斷</template
        >
      </span>
      <UiButton
        variant="invisible"
        :disabled="handoffImportApplying || importableHandoffs.length === 0"
        @click="selectAllHandoffs"
        >全選可匯入</UiButton
      >
      <UiButton
        variant="invisible"
        :disabled="handoffImportApplying || selectedHandoffCount === 0"
        @click="clearHandoffSelection"
        >清除選取</UiButton
      >
      <UiButton
        variant="primary"
        :loading="handoffImportApplying"
        :disabled="selectedHandoffCount === 0"
        @click="applyHandoffImport"
        >匯入選取項目</UiButton
      >
    </template>
  </UiDialog>
</template>

<style scoped>
.handoff__intro {
  margin-bottom: var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.handoff__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.handoff__list {
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.handoff__list :deep(.virtual-list-item + .virtual-list-item) {
  border-top: 1px solid var(--border-muted);
}

.handoff__item {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  cursor: pointer;
}

.handoff__item.is-disabled {
  cursor: default;
}

.handoff__item input {
  margin-top: 3px;
  accent-color: var(--accent-emphasis);
}

.handoff__copy {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.handoff__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.handoff__copy code,
.handoff__copy small,
.handoff__summary {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.handoff__summary {
  font-size: var(--text-sm);
}

.handoff__selection {
  margin-right: auto;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

@media (max-width: 639px) {
  .handoff__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

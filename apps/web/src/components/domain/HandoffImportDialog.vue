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
import { t } from "../../i18n";

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
    return t("projects.files", { length: item.changedFiles.length });
  }
  return item.changedFilesStatus === "not_found"
    ? t("projects.noFileMetadataFoundYet")
    : t("projects.fileMetadataNotRead");
}
</script>

<template>
  <UiDialog
    :open="Boolean(handoffImportPreview)"
    :title="t('projects.pastHandoffImportPreview')"
    :description="description"
    size="lg"
    :busy="handoffImportApplying"
    @close="closeHandoffImport"
  >
    <template v-if="handoffImportPreview">
      <p class="handoff__intro">
        {{ t("projects.onlyDocumentsExplicitlyMarkedComplete") }}
      </p>
      <UiFlash v-if="handoffImportError" tone="danger">{{ handoffImportError }}</UiFlash>
      <div class="handoff__stats">
        <UiStatCard :label="t('projects.discovered')" :value="handoffImportPreview.totals.discovered" />
        <UiStatCard
          :label="t('projects.importable')"
          :value="handoffImportPreview.totals.eligible"
          value-tone="success"
        />
        <UiStatCard :label="t('projects.imported')" :value="handoffImportPreview.totals.alreadyImported" />
        <UiStatCard
          :label="t('projects.skippedErrors')"
          :value="handoffImportPreview.totals.excluded + handoffImportPreview.totals.errors"
        />
      </div>
      <UiEmptyState
        v-if="!handoffImportPreview.directoryFound"
        compact
        :icon="FileText"
        :title="t('projects.handoffFolderNotFound')"
        :description="
          t('projects.doesNotExistOrHas', {
            handoffDirectory: handoffImportPreview.handoffDirectory,
          })
        "
      />
      <VirtualList
        v-else
        class="handoff__list"
        :items="handoffImportPreview.items"
        :enabled="true"
        :estimate-item-height="128"
        max-height="min(56vh, 560px)"
        :label="t('projects.handoffImportPreviewList')"
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
                <template v-if="item.recordedDate"
                  >{{ t("projects.recorded", { recordedDate: item.recordedDate }) }} </template
                >{{ filesText(item) }}<template v-if="item.detail"> · {{ item.detail }}</template>
              </small>
            </span>
          </label>
        </template>
      </VirtualList>
    </template>
    <template #footer>
      <span class="handoff__selection">
        {{ t("projects.selected", { selectedHandoffCount })
        }}<template v-if="handoffImportPreview?.truncated">
          {{ t("projects.fileLimitReachedPreviewTruncated") }}</template
        >
      </span>
      <UiButton
        variant="invisible"
        :disabled="handoffImportApplying || importableHandoffs.length === 0"
        @click="selectAllHandoffs"
        >{{ t("projects.selectAllImportable") }}</UiButton
      >
      <UiButton
        variant="invisible"
        :disabled="handoffImportApplying || selectedHandoffCount === 0"
        @click="clearHandoffSelection"
        >{{ t("projects.clearSelection") }}</UiButton
      >
      <UiButton
        variant="primary"
        :loading="handoffImportApplying"
        :disabled="selectedHandoffCount === 0"
        @click="applyHandoffImport"
        >{{ t("projects.importSelected") }}</UiButton
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

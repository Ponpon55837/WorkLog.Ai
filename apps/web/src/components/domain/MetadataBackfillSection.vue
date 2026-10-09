<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { CircleCheckBig, RefreshCw, ScanSearch, X } from "lucide-vue-next";
import UiSelect from "../ui/UiSelect.vue";
import { useProjectsStore } from "../../stores/projects";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { useToast } from "../../composables/useToast";
import { metadataBackfillInstruction, useMetadataBackfillStore } from "../../stores/metadata-backfill";
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
import VirtualList from "../VirtualList.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

/**
 * Metadata gap scan and the Agent request. The UI only reads stored metadata and creates
 * requests; it never writes guessed changed files or verification.
 */
const metadataBackfillStore = useMetadataBackfillStore();
const {
  projectId,
  requestId,
  metadataBackfillPreview: preview,
  metadataBackfillLoading,
  metadataBackfillError,
  metadataBackfillRequest: request,
  metadataBackfillRequestIsActive,
  metadataBackfillRequestLoading,
  metadataBackfillRequestCreating,
  metadataBackfillRequestError,
} = storeToRefs(metadataBackfillStore);
const {
  loadMetadataBackfillRequest,
  refreshMetadataBackfillRequest,
  createMetadataBackfillRequest,
  cancelMetadataBackfillRequest,
  previewMetadataBackfill,
  openMetadataBackfillSession,
} = metadataBackfillStore;
const { showToast } = useToast();

useActiveRequestWatch({
  requests: () => (request.value ? [request.value] : []),
  check: refreshMetadataBackfillRequest,
  onSettled: (_request, status) => {
    if (status === "completed") {
      showToast(t("projects.theAgentFinishedTheMetadata"), "success");
      // The gap list is a separate scan; rerun it so resolved gaps disappear.
      void previewMetadataBackfill();
    } else if (status === "failed") {
      showToast(t("projects.theMetadataBackfillDidNot"), "danger");
    }
  },
});

const projectOptions = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...useProjectsStore().trackedProjects.map((project) => ({ value: project.id, label: project.name })),
]);

const requestMessage = computed(() => {
  if (!request.value) {
    return "";
  }
  if (metadataBackfillRequestIsActive.value) {
    return t("projects.pasteTheInstructionBelowInto");
  }
  if (request.value.status === "completed") {
    return t("projects.thisMetadataBackfillIsComplete");
  }
  return preview.value?.items.length
    ? t("projects.thisMetadataBackfillDidNotFinishCreateA")
    : t("projects.thisMetadataBackfillDidNot");
});
</script>

<template>
  <div class="backfill">
    <UiSelect
      v-model="projectId"
      :options="projectOptions"
      :label="t('common.project')"
      @update:model-value="requestId = ''"
    />
    <UiFlash v-if="metadataBackfillError" tone="danger">{{ metadataBackfillError }}</UiFlash>
    <UiFlash v-if="metadataBackfillRequestError" tone="danger">{{ metadataBackfillRequestError }}</UiFlash>

    <UiBox v-if="request" padded>
      <template #header>
        <UiBoxTitle eyebrow="Agent request" :title="t('projects.askAgentToBackfillMetadata')" />
        <div class="backfill__request-actions">
          <StatusLabel :status="requestStatus[request.status]" />
          <UiIconButton
            :icon="RefreshCw"
            :label="t('projects.refreshBackfillStatus')"
            size="sm"
            :loading="metadataBackfillRequestLoading"
            @click="loadMetadataBackfillRequest"
          />
        </div>
      </template>
      <p class="backfill__message">{{ requestMessage }}</p>
      <UiCommandBlock
        v-if="metadataBackfillRequestIsActive"
        :text="metadataBackfillInstruction()"
        :success-message="t('projects.naturalLanguageMetadataBackfillInstruction')"
      />
      <div class="backfill__buttons">
        <UiButton
          v-if="metadataBackfillRequestIsActive"
          variant="danger"
          size="sm"
          :icon="X"
          :disabled="metadataBackfillRequestLoading"
          @click="cancelMetadataBackfillRequest"
          >{{ t("projects.cancelBackfill") }}</UiButton
        >
        <UiButton
          v-else-if="preview?.items.length"
          size="sm"
          :loading="metadataBackfillRequestCreating"
          @click="createMetadataBackfillRequest"
          >{{ t("projects.createBackfillRequestAgain") }}</UiButton
        >
      </div>
    </UiBox>
    <UiFlash v-else-if="preview?.items.length" tone="attention" :title="t('projects.theseGapsNeedAgentConfirmation')">
      {{ t("projects.theScanNeverGuessesFiles") }}
      <template #actions
        ><UiButton
          variant="primary"
          size="sm"
          :loading="metadataBackfillRequestCreating"
          @click="createMetadataBackfillRequest"
          >{{ t("projects.askAgentToBackfill") }}</UiButton
        ></template
      >
    </UiFlash>

    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle
          eyebrow="Agent follow-ups"
          :title="t('projects.sessionsThatNeedBackfill')"
          :count="preview?.items.length"
        />
        <UiButton size="sm" :icon="ScanSearch" :loading="metadataBackfillLoading" @click="previewMetadataBackfill">{{
          preview ? t("projects.rescan") : t("projects.scanMetadataGaps")
        }}</UiButton>
      </template>
      <UiEmptyState
        v-if="!preview"
        compact
        :icon="ScanSearch"
        :title="t('projects.notScannedYet')"
        :description="t('projects.theScanReadsOnlySession')"
      />
      <template v-else>
        <div class="backfill__stats">
          <UiStatCard
            :label="t('projects.needsBackfill')"
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
          :title="t('projects.nothingAwaitingBackfill')"
          :description="t('projects.everyTrackedSessionHasThe')"
        />
        <VirtualList
          :items="preview.items"
          :enabled="true"
          fit-viewport
          fit-viewport-to-panel
          fill-available-space
          :estimate-item-height="72"
          :label="t('projects.metadataBackfillList')"
        >
          <template #default="{ item }">
            <UiBoxRow clickable :title="item.title" @select="openMetadataBackfillSession(item)">
              <template #labels>
                <StatusLabel v-for="gap in metadataGapsOf(item)" :key="gap" :status="metadataGapStatus[gap]" />
              </template>
              <template #meta>
                {{ item.projectName }} ·
                <time :title="formatDate(item.completedAt)">{{ formatRelative(item.completedAt) }}</time>
                {{
                  t("projects.filesHandoffSnapshots", {
                    changedFilesCount: item.changedFilesCount,
                    rawSnapshotCount: item.rawSnapshotCount,
                  })
                }}
              </template>
              <template #trailing
                ><StatusLabel class="hide-sm" :status="verificationStatus[item.verificationStatus]" :show-icon="false"
              /></template>
            </UiBoxRow>
          </template>
        </VirtualList>
        <p v-if="preview.truncated" class="backfill__note">
          {{ t("projects.resultsReachedTheDisplayLimit") }}
        </p>
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

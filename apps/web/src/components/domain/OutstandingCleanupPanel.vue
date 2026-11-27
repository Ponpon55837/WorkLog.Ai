<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ExternalLink, Link2, ListChecks, RotateCcw } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import type { OutstandingCleanupProposal } from "@work-intelligence/core";
import AgentHandoffNotice from "./AgentHandoffNotice.vue";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSidePanelHeader from "../ui/UiSidePanelHeader.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { confirmAction } from "../../composables/useConfirm";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../../composables/useRouteQuery";
import { useToast } from "../../composables/useToast";
import { useOutstandingCleanupStore, type OutstandingPendingProject } from "../../stores/outstanding-cleanup";
import { useProjectsStore } from "../../stores/projects";
import { errorMessage, formatDate } from "../../utils/format";
import { listPageSizeOptions } from "../../utils/labels";
import {
  outstandingCleanupRequestVisual,
  outstandingCleanupVerdictVisual,
  outstandingItemStatusVisual,
} from "../../utils/status";
import { t } from "../../i18n";

const emit = defineEmits<{ openSession: [sessionId: string] }>();
const pageSizes = listPageSizeOptions.map((option) => option.value);

const route = useRoute();
const cleanupStore = useOutstandingCleanupStore();
const {
  projectId,
  canChangeProject,
  requestId,
  requestPage,
  requestPageSize,
  proposalPage,
  proposalPageSize,
  pendingProjects,
  pendingProjectsLoaded,
  pendingProjectsError,
  requestsLoaded,
  requests,
  requestPageInfo,
  proposals,
  proposalPageInfo,
  selectedRequest,
  activeRequest,
  loading,
  proposalsLoading,
  error,
  proposalError,
  skipped,
} = storeToRefs(cleanupStore);
const { projects } = storeToRefs(useProjectsStore());
const { showToast } = useToast();
useRouteQuery("cleanupRequest", requestId, stringQuery());
useRouteQuery("cleanupRequestPage", requestPage, pageQuery());
useRouteQuery("cleanupRequestSize", requestPageSize, enumQuery(pageSizes, 10));
useRouteQuery("cleanupPage", proposalPage, pageQuery());
useRouteQuery("cleanupSize", proposalPageSize, enumQuery(pageSizes, 10));

const panelMode = ref("");
const selectedIds = ref<string[]>([]);
const busy = ref(false);
const createKey = ref("");
useRouteQuery("cleanup", panelMode, enumQuery(["", "review"], ""));

const isOpen = computed(() => panelMode.value === "review");
const projectName = computed(() => projects.value.find((project) => project.id === projectId.value)?.name ?? "");
const onlyProject = computed(() => (pendingProjects.value.length === 1 ? pendingProjects.value[0] : undefined));
const closedProposals = computed(() => proposals.value.filter((proposal) => proposal.itemStatus !== "pending"));
const allSelected = computed({
  get: () => closedProposals.value.length > 0 && selectedIds.value.length === closedProposals.value.length,
  set: (selected: boolean) => {
    selectedIds.value = selected ? closedProposals.value.slice(0, 100).map((proposal) => proposal.itemId) : [];
  },
});
const createDisabledReason = computed(() => {
  if (!requestsLoaded.value) return t("common.loading");
  return skipped.value ? t("outstanding.trackingIsNotEnabledFor") : undefined;
});

function pendingCountText(project: OutstandingPendingProject): string {
  return project.pendingCount === undefined
    ? ""
    : t("outstanding.cleanupPendingCount", { count: project.pendingCount });
}
function onlyProjectLabel(project: OutstandingPendingProject): string {
  return project.pendingCount === undefined
    ? project.projectName
    : t("outstanding.cleanupOnlyProject", { project: project.projectName, count: project.pendingCount });
}
function close(): void {
  panelMode.value = "";
}
function verdictVisual(proposal: OutstandingCleanupProposal) {
  return outstandingCleanupVerdictVisual[proposal.kind === "acknowledged" ? "acknowledged" : proposal.status];
}
function selectProposal(itemId: string, selected: boolean): void {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, itemId])].slice(0, 100)
    : selectedIds.value.filter((value) => value !== itemId);
}
function openSession(id: string): void {
  close();
  emit("openSession", id);
}
async function createRequest(): Promise<void> {
  if (busy.value || !projectId.value) return;
  if (
    !(await confirmAction({
      title: t("outstanding.createARequestToTidy"),
      message: t("outstanding.theAgentChecksThisProject"),
      confirmLabel: t("outstanding.createRequest"),
      cancelLabel: t("common.cancel"),
    }))
  )
    return;
  busy.value = true;
  createKey.value ||= crypto.randomUUID();
  try {
    await cleanupStore.createRequest(createKey.value);
    createKey.value = "";
    showToast(t("outstanding.requestCreatedYouCanNow"), "success");
  } catch (error) {
    showToast(errorMessage(error, t("common.couldNotCreateTheRequest")), "danger");
  } finally {
    busy.value = false;
  }
}
async function reopen(itemIds: string[]): Promise<void> {
  if (busy.value || !itemIds.length) return;
  busy.value = true;
  try {
    const closed = new Map(closedProposals.value.map((proposal) => [proposal.itemId, proposal.itemStatus]));
    const { reopened, skipped, failure } = await cleanupStore.reopen(
      itemIds.flatMap((itemId) => {
        const status = closed.get(itemId);
        return status ? [{ itemId, status }] : [];
      }),
    );
    if (failure) {
      const reason = errorMessage(failure, t("outstanding.couldNotUpdateTheOpenItemPleaseTry"));
      showToast(t("outstanding.partiallyUpdated", { updated: reopened, total: itemIds.length, reason }), "danger");
      return;
    }
    selectedIds.value = [];
    // Items the Agent closed record `cleanup_review`, and an undo would rewrite that to the user, so there is none.
    showToast(
      skipped > 0
        ? t("outstanding.updatedAndSkipped", { updated: reopened, skipped })
        : t("outstanding.restoredItemsToPending", { length: reopened }),
      "success",
    );
  } finally {
    busy.value = false;
  }
}
async function cancelRequest(id: string): Promise<void> {
  if (
    busy.value ||
    !(await confirmAction({
      title: t("outstanding.cancelThisRequest"),
      message: t("outstanding.existingSuggestionsStayReadableAnd"),
      confirmLabel: t("outstanding.cancelRequest"),
      cancelLabel: t("outstanding.keepRequest"),
    }))
  )
    return;
  busy.value = true;
  try {
    await cleanupStore.cancelRequest(id);
    showToast(t("outstanding.requestCancelled"), "success");
  } catch (error) {
    showToast(errorMessage(error, t("outstanding.couldNotCancelTheRequest")), "danger");
  } finally {
    busy.value = false;
  }
}

watch(isOpen, (open) => cleanupStore.setActive(open), { immediate: true });
watch(requests, (items) => {
  if (!requestId.value && items.length) requestId.value = items[0]?.id ?? "";
});
watch(projectId, () => {
  if (route.query.itemProject !== projectId.value) requestId.value = "";
  createKey.value = "";
  selectedIds.value = [];
});
// URL hydration/back navigation retains its page; only an interactive filter change resets it.
watch([projectId, proposalPageSize, requestId], () => {
  if (
    route.query.itemProject === projectId.value &&
    (route.query.cleanupRequest ?? "") === requestId.value &&
    String(route.query.cleanupSize ?? 10) === String(proposalPageSize.value)
  )
    return;
  proposalPage.value = 1;
});
watch([projectId, requestPageSize], () => {
  if (
    route.query.itemProject === projectId.value &&
    String(route.query.cleanupRequestSize ?? 10) === String(requestPageSize.value)
  )
    return;
  requestPage.value = 1;
});
watch([requestId, proposalPage, proposalPageSize], () => {
  selectedIds.value = [];
});
watch(closedProposals, (items) => {
  const eligibleIds = new Set(items.map((item) => item.itemId));
  selectedIds.value = selectedIds.value.filter((id) => eligibleIds.has(id));
});

onBeforeUnmount(() => cleanupStore.setActive(false));
</script>

<template>
  <UiButton size="sm" :icon="ListChecks" @click="panelMode = 'review'">{{ t("outstanding.tidyOpenItems") }}</UiButton>
  <UiSidePanel :open="isOpen" :label="t('outstanding.tidyOpenItems')" :width="720" @close="close">
    <template #header>
      <UiSidePanelHeader
        :title="t('outstanding.tidyOpenItems')"
        :close-label="t('outstanding.closeOpenItemCleanup')"
        @close="close"
      />
    </template>
    <div class="outstanding-cleanup__body">
      <div v-if="!projectId" class="outstanding-cleanup__choose" data-testid="outstanding-cleanup-projects">
        <UiFlash v-if="pendingProjectsError" tone="danger">
          {{ pendingProjectsError }}
          <template #actions
            ><UiButton size="sm" @click="cleanupStore.reloadPendingProjects">{{
              t("common.retry")
            }}</UiButton></template
          >
        </UiFlash>
        <UiSkeleton v-else-if="!pendingProjectsLoaded" :count="2" :label="t('common.loading')" />
        <p v-else-if="pendingProjects.length === 0" class="outstanding-cleanup__hint">
          {{ t("outstanding.cleanupNothingPending") }}
        </p>
        <template v-else>
          <p class="outstanding-cleanup__hint">{{ t("outstanding.cleanupChooseProject") }}</p>
          <div v-if="onlyProject" class="outstanding-cleanup__project">
            <UiButton variant="primary" @click="cleanupStore.chooseProject(onlyProject.projectId)">{{
              onlyProjectLabel(onlyProject)
            }}</UiButton>
          </div>
          <ul v-else class="outstanding-cleanup__projects" :aria-label="t('outstanding.cleanupProjectList')">
            <li
              v-for="project in pendingProjects"
              :key="project.projectId"
              class="outstanding-cleanup__project"
              data-testid="outstanding-cleanup-project"
            >
              <span class="outstanding-cleanup__project-name">{{ project.projectName }}</span>
              <span v-if="pendingCountText(project)" class="outstanding-cleanup__hint">{{
                pendingCountText(project)
              }}</span>
              <UiButton
                size="sm"
                variant="primary"
                :aria-label="t('outstanding.cleanupChooseLabel', { project: project.projectName })"
                @click="cleanupStore.chooseProject(project.projectId)"
                >{{ t("outstanding.cleanupChoose") }}</UiButton
              >
            </li>
          </ul>
        </template>
      </div>
      <template v-else>
        <div class="outstanding-cleanup__project">
          <strong class="outstanding-cleanup__project-name">{{ projectName }}</strong>
          <UiButton v-if="canChangeProject" size="sm" variant="invisible" @click="cleanupStore.changeProject">{{
            t("outstanding.cleanupChangeProject")
          }}</UiButton>
        </div>
        <AgentHandoffNotice
          v-if="activeRequest"
          class="outstanding-cleanup__handoff"
          :status="outstandingCleanupRequestVisual[activeRequest.status]"
          :message="t('outstanding.cleanupHandoffMessage')"
          :command="t('outstanding.cleanupCommand')"
          :cancel-label="t('outstanding.cancelRequest')"
          :cancel-disabled="busy"
          @cancel="cancelRequest(activeRequest.id)"
        />
        <template v-else>
          <p class="outstanding-cleanup__hint">
            {{ t("outstanding.askTheAgentToTidy") }}
          </p>
          <div class="outstanding-cleanup__actions">
            <UiButton
              variant="primary"
              :disabled="busy || Boolean(createDisabledReason)"
              :disabled-reason="createDisabledReason"
              @click="createRequest"
              >{{ t("outstanding.createRequest") }}</UiButton
            >
          </div>
        </template>
        <UiFlash v-if="skipped" tone="accent">{{ t("outstanding.trackingIsNotEnabledFor") }}</UiFlash>
        <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
        <UiBox>
          <template #header
            ><UiBoxTitle
              :title="t('common.cleanupRequests')"
              :count="requestsLoaded ? requestPageInfo.total : undefined"
          /></template>
          <UiSkeleton v-if="loading && !requestsLoaded" :count="2" />
          <UiEmptyState
            v-else-if="!error && !requests.length"
            :title="t('outstanding.noRequestsYet')"
            :description="t('outstanding.afterCreatingARequestYou')"
          />
          <VirtualList
            v-else-if="!error"
            :items="requests"
            :item-key="(item) => item.id"
            :enabled="requests.length > 3"
            max-height="240px"
            :label="t('outstanding.requestList')"
          >
            <template #default="{ item }">
              <UiBoxRow
                :title="formatDate(item.requestedAt)"
                clickable
                :class="{ 'is-selected': item.id === requestId }"
                :aria-current="item.id === requestId ? 'true' : undefined"
                @select="requestId = item.id"
              >
                <template #labels><StatusLabel :status="outstandingCleanupRequestVisual[item.status]" /></template>
                <template #meta>{{
                  t("outstanding.checkedItemsToReview", {
                    examinedCount: item.examinedCount,
                    itemCount: item.itemCount,
                    proposalCount: item.proposalCount,
                  })
                }}</template>
              </UiBoxRow>
            </template>
          </VirtualList>
          <template v-if="requestsLoaded" #footer
            ><UiPagination
              v-model:page-size="requestPageSize"
              :page-info="requestPageInfo"
              :size-label="t('outstanding.requestsPerPage')"
              @page="requestPage = $event"
          /></template>
        </UiBox>
        <UiBox v-if="requestId">
          <template #header>
            <UiBoxTitle :title="t('outstanding.closedByAgent')" :count="proposalPageInfo.total" />
          </template>
          <div v-if="selectedRequest" class="outstanding-cleanup__summary">
            <StatusLabel :status="outstandingCleanupRequestVisual[selectedRequest.status]" />
            <span>{{
              t("outstanding.checkedItems", {
                examinedCount: selectedRequest.examinedCount,
                itemCount: selectedRequest.itemCount,
              })
            }}</span>
            <span>{{ t("outstanding.itemsWithoutASuggestionStay") }}</span>
          </div>
          <div v-if="closedProposals.length" class="outstanding-cleanup__selection">
            <label class="outstanding-cleanup__select-page">
              <UiCheckbox
                v-model="allSelected"
                :label="t('outstanding.selectAllClosedOnThisPage')"
                :indeterminate="selectedIds.length > 0 && !allSelected"
                :disabled="busy"
              />
              <span v-if="selectedIds.length === 0">{{ t("outstanding.selectPage") }}</span>
            </label>
            <div
              v-if="selectedIds.length > 0"
              class="outstanding-cleanup__batch"
              role="group"
              :aria-label="t('outstanding.reopenClosedItemsInBulk')"
              data-testid="outstanding-cleanup-batch-toolbar"
            >
              <span aria-live="polite">{{ t("outstanding.selected", { length: selectedIds.length }) }}</span>
              <UiButton size="sm" :disabled="busy" @click="reopen([...selectedIds])">{{
                t("outstanding.reopenSelected")
              }}</UiButton>
            </div>
          </div>
          <UiFlash v-if="proposalError" tone="danger">{{ proposalError }}</UiFlash>
          <UiSkeleton v-if="proposalsLoading && !proposals.length" :count="3" />
          <UiEmptyState
            v-else-if="!proposalError && !proposals.length"
            :title="t('outstanding.noClosedItemsYet')"
            :description="t('outstanding.whileARequestAwaitsCleanup')"
          />
          <VirtualList
            v-else-if="!proposalError"
            :items="proposals"
            :item-key="(item) => item.id"
            :enabled="proposals.length > 3"
            max-height="440px"
            :estimate-item-height="64"
            :label="t('outstanding.closedItemList')"
          >
            <template #default="{ item }">
              <UiBoxRow class="outstanding-cleanup__proposal" data-testid="outstanding-cleanup-proposal">
                <template #leading
                  ><UiCheckbox
                    v-if="item.itemStatus !== 'pending'"
                    :model-value="selectedIds.includes(item.itemId)"
                    :label="t('outstanding.selectClosedItem', { itemText: item.itemText })"
                    :disabled="busy"
                    @update:model-value="selectProposal(item.itemId, $event)"
                /></template>
                <template #title
                  ><span :title="item.itemText">{{ item.itemText }}</span></template
                >
                <template #labels
                  ><StatusLabel v-if="item.itemStatus === 'pending'" :status="outstandingItemStatusVisual.pending"
                /></template>
                <template #meta>
                  <StatusLabel :status="verdictVisual(item)" />
                  <span class="outstanding-cleanup__reason" :title="item.reason">{{ item.reason }}</span>
                </template>
                <template #trailing>
                  <div class="outstanding-cleanup__row-actions">
                    <UiButton
                      size="sm"
                      :icon="ExternalLink"
                      icon-only
                      :label="t('common.sourceSession')"
                      :aria-label="t('outstanding.openSourceSessionOf', { text: item.itemText })"
                      @click="openSession(item.sourceSessionId)"
                    />
                    <UiButton
                      v-for="(id, index) in item.evidenceSessionIds"
                      :key="id"
                      size="sm"
                      :icon="Link2"
                      icon-only
                      :label="t('outstanding.evidence', { value: index + 1 })"
                      :aria-label="t('outstanding.openEvidenceOf', { value: index + 1, text: item.itemText })"
                      @click="openSession(id)"
                    />
                    <UiButton
                      v-if="item.itemStatus !== 'pending'"
                      size="sm"
                      :icon="RotateCcw"
                      icon-only
                      :label="t('outstanding.reopen')"
                      :aria-label="t('outstanding.reopenItem', { text: item.itemText })"
                      :disabled="busy"
                      @click="reopen([item.itemId])"
                    />
                  </div>
                </template>
              </UiBoxRow>
            </template>
          </VirtualList>
          <template #footer
            ><UiPagination
              v-model:page-size="proposalPageSize"
              :page-info="proposalPageInfo"
              :size-label="t('outstanding.closedItemsPerPage')"
              @page="proposalPage = $event"
          /></template>
        </UiBox>
      </template>
    </div>
  </UiSidePanel>
</template>

<style scoped>
.outstanding-cleanup__actions,
.outstanding-cleanup__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.outstanding-cleanup__body {
  padding: var(--space-4);
}
.outstanding-cleanup__projects {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.outstanding-cleanup__project {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}
.outstanding-cleanup__projects .outstanding-cleanup__project {
  margin-bottom: 0;
}
.outstanding-cleanup__project-name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.outstanding-cleanup__project .ui-button:last-child:not(:only-child) {
  margin-inline-start: auto;
}
.outstanding-cleanup__body > .outstanding-cleanup__actions {
  margin-bottom: var(--space-4);
}
.outstanding-cleanup__handoff {
  margin-bottom: var(--space-4);
}
.outstanding-cleanup__hint {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
.outstanding-cleanup__summary {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-xs);
}
p.outstanding-cleanup__hint {
  margin: 0 0 var(--space-3);
}
.outstanding-cleanup__selection {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-8);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.outstanding-cleanup__select-page {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
}
.outstanding-cleanup__batch {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.outstanding-cleanup__body .is-selected {
  background: var(--bg-subtle);
}
.outstanding-cleanup__proposal {
  align-items: center;
  padding-block: var(--space-2);
}
.outstanding-cleanup__proposal :deep(.ui-box-row__leading) {
  padding-top: 0;
}
.outstanding-cleanup__proposal :deep(.ui-box-row__text) {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.outstanding-cleanup__reason {
  margin-inline-start: var(--space-1);
}
.outstanding-cleanup__row-actions {
  display: flex;
  gap: var(--space-1);
}
@media (max-width: 639px) {
  .outstanding-cleanup__body {
    padding: var(--space-2);
  }
  .outstanding-cleanup__proposal {
    flex-wrap: wrap;
  }
  .outstanding-cleanup__proposal :deep(.ui-box-row__meta) {
    white-space: normal;
  }
  .outstanding-cleanup__proposal :deep(.ui-box-row__trailing) {
    flex-basis: 100%;
    justify-content: flex-end;
  }
}
</style>

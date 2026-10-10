<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ListChecks, RefreshCw, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import type { OutstandingCleanupProposalStatus } from "@work-intelligence/core";
import StatusLabel from "./StatusLabel.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { confirmAction } from "../../composables/useConfirm";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../../composables/useRouteQuery";
import { useToast } from "../../composables/useToast";
import { useOutstandingCleanupStore } from "../../stores/outstanding-cleanup";
import { errorMessage, formatDate } from "../../utils/format";
import { listPageSizeOptions } from "../../utils/labels";
import {
  outstandingCleanupProposalVisual,
  outstandingCleanupRequestVisual,
  outstandingItemStatusVisual,
} from "../../utils/status";
import { t } from "../../i18n";

/** Lets a person create a project cleanup request and review evidence before changing any item. */
const emit = defineEmits<{ openSession: [sessionId: string] }>();
const reviewOptions = (Object.keys(outstandingCleanupProposalVisual) as OutstandingCleanupProposalStatus[]).map(
  (value) => ({ value, ...outstandingCleanupProposalVisual[value] }),
);
const pageSizes = listPageSizeOptions.map((option) => option.value);

const route = useRoute();
const cleanupStore = useOutstandingCleanupStore();
const {
  projectId,
  requestId,
  requestPage,
  requestPageSize,
  reviewStatus,
  proposalPage,
  proposalPageSize,
  requestsLoaded,
  requests,
  requestPageInfo,
  proposals,
  proposalPageInfo,
  selectedRequest,
  hasActiveRequest,
  loading,
  proposalsLoading,
  error,
  proposalError,
  skipped,
} = storeToRefs(cleanupStore);
const { showToast } = useToast();
useRouteQuery("cleanupRequest", requestId, stringQuery());
useRouteQuery("cleanupRequestPage", requestPage, pageQuery());
useRouteQuery("cleanupRequestSize", requestPageSize, enumQuery(pageSizes, 10));
useRouteQuery("cleanupReview", reviewStatus, enumQuery(["pending", "accepted", "rejected"], "pending"));
useRouteQuery("cleanupPage", proposalPage, pageQuery());
useRouteQuery("cleanupSize", proposalPageSize, enumQuery(pageSizes, 10));

const panelMode = ref("");
const selectedIds = ref<string[]>([]);
const busy = ref(false);
const createKey = ref("");
useRouteQuery("cleanup", panelMode, enumQuery(["", "review"], ""));

const isOpen = computed(() => panelMode.value === "review" && Boolean(projectId.value));
const pendingProposals = computed(() => proposals.value.filter((proposal) => proposal.reviewStatus === "pending"));
const allSelected = computed({
  get: () => pendingProposals.value.length > 0 && selectedIds.value.length === pendingProposals.value.length,
  set: (selected: boolean) => {
    selectedIds.value = selected ? pendingProposals.value.slice(0, 100).map((proposal) => proposal.id) : [];
  },
});
const hasStaleSelection = computed(() =>
  proposals.value.some((proposal) => selectedIds.value.includes(proposal.id) && proposal.stale),
);
const canReview = computed(
  () => selectedRequest.value?.status === "pending" || selectedRequest.value?.status === "awaiting_review",
);

const staleMessage = computed(() =>
  selectedRequest.value?.status === "cancelled"
    ? t("outstanding.theRequestWasCancelledExisting")
    : t("outstanding.itemsSourcesOrEvidenceChanged"),
);

function close(): void {
  panelMode.value = "";
}
function selectProposal(id: string, selected: boolean): void {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, id])].slice(0, 100)
    : selectedIds.value.filter((value) => value !== id);
}
function selectRequest(id: string): void {
  requestId.value = id;
  reviewStatus.value = "pending";
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
async function decide(ids: string[], decision: "accept" | "reject"): Promise<void> {
  if (busy.value || !ids.length) return;
  const accept = decision === "accept";
  if (
    !(await confirmAction({
      title: accept ? t("outstanding.acceptSuggestions") : t("outstanding.rejectSuggestions"),
      message: accept
        ? t("outstanding.acceptingTheseSuggestionsSetsThe", {
            length: ids.length,
          })
        : t("outstanding.rejectTheseSuggestionsOpenItems", { length: ids.length }),
      confirmLabel: accept ? t("outstanding.confirmAcceptance") : t("outstanding.confirmRejection"),
      cancelLabel: t("outstanding.backToReview"),
    }))
  )
    return;
  busy.value = true;
  try {
    await cleanupStore.decide(ids, decision);
    selectedIds.value = [];
    showToast(
      accept ? t("outstanding.suggestionsAccepted") : t("outstanding.suggestionsRejectedOpenItemsAre"),
      "success",
    );
  } catch (error) {
    showToast(errorMessage(error, t("outstanding.couldNotReviewTheSuggestions")), "danger");
  } finally {
    busy.value = false;
  }
}
async function cancelRequest(): Promise<void> {
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
    await cleanupStore.cancelRequest();
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
watch([projectId, reviewStatus, proposalPageSize, requestId], () => {
  if (
    route.query.itemProject === projectId.value &&
    (route.query.cleanupRequest ?? "") === requestId.value &&
    (route.query.cleanupReview ?? "pending") === reviewStatus.value &&
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
watch([requestId, reviewStatus, proposalPage, proposalPageSize], () => {
  selectedIds.value = [];
});
watch([pendingProposals, canReview], ([items, reviewable]) => {
  const eligibleIds = new Set(reviewable ? items.map((item) => item.id) : []);
  selectedIds.value = selectedIds.value.filter((id) => eligibleIds.has(id));
});

onBeforeUnmount(() => cleanupStore.setActive(false));
</script>

<template>
  <div class="outstanding-cleanup__entry">
    <UiButton size="sm" :icon="ListChecks" :disabled="!projectId" @click="panelMode = 'review'">{{
      t("outstanding.tidyOpenItems")
    }}</UiButton>
    <span v-if="!projectId" class="outstanding-cleanup__hint">{{ t("outstanding.chooseAProjectFirst") }}</span>
  </div>
  <UiSidePanel :open="isOpen" :label="t('outstanding.tidyOpenItems')" :width="720" @close="close">
    <template #header>
      <h2>{{ t("outstanding.tidyOpenItems") }}</h2>
      <UiButton size="sm" :icon="X" icon-only :label="t('outstanding.closeOpenItemCleanup')" @click="close" />
    </template>
    <div class="outstanding-cleanup__body">
      <p class="outstanding-cleanup__hint">
        {{ t("outstanding.askTheAgentToTidy") }}
      </p>
      <div class="outstanding-cleanup__actions">
        <UiButton
          variant="primary"
          :disabled="busy || !requestsLoaded || skipped || hasActiveRequest"
          @click="createRequest"
          >{{ t("outstanding.createRequest") }}</UiButton
        >
        <UiButton :icon="RefreshCw" :disabled="busy" @click="cleanupStore.reload">{{ t("common.refresh") }}</UiButton>
      </div>
      <UiFlash v-if="skipped" tone="accent">{{ t("outstanding.trackingIsNotEnabledFor") }}</UiFlash>
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiBox>
        <template #header
          ><UiBoxTitle :title="t('common.cleanupRequests')" :count="requestsLoaded ? requestPageInfo.total : undefined"
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
              @select="selectRequest(item.id)"
            >
              <template #labels><StatusLabel :status="outstandingCleanupRequestVisual[item.status]" /></template>
              <template #meta>{{
                t("outstanding.checkedItemsToReview", {
                  examinedCount: item.examinedCount,
                  itemCount: item.itemCount,
                  pendingProposalCount: item.pendingProposalCount,
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
          <UiBoxTitle :title="t('common.suggestions')" :count="proposalPageInfo.total" />
          <UiActionMenu
            v-model="reviewStatus"
            :label="t('outstanding.reviewStatus')"
            :header="t('outstanding.filterSuggestions')"
            :items="reviewOptions"
            default-value="pending"
          />
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
          <UiButton v-if="canReview" size="sm" :disabled="busy" @click="cancelRequest">{{
            t("outstanding.cancelRequest")
          }}</UiButton>
        </div>
        <div
          v-if="reviewStatus === 'pending' && pendingProposals.length"
          class="outstanding-cleanup__actions outstanding-cleanup__batch"
          role="group"
          :aria-label="t('outstanding.reviewSuggestionsInBulk')"
        >
          <UiCheckbox
            v-model="allSelected"
            :label="t('outstanding.selectAllSuggestionsOnThis')"
            :indeterminate="selectedIds.length > 0 && !allSelected"
            :disabled="busy || !canReview"
          />
          <span aria-live="polite">{{ t("outstanding.selected", { length: selectedIds.length }) }}</span>
          <UiButton
            size="sm"
            :disabled="busy || !canReview || !selectedIds.length || hasStaleSelection"
            @click="decide([...selectedIds], 'accept')"
            >{{ t("outstanding.acceptSelected") }}</UiButton
          >
          <UiButton
            size="sm"
            :disabled="busy || !canReview || !selectedIds.length"
            @click="decide([...selectedIds], 'reject')"
            >{{ t("outstanding.rejectSelected") }}</UiButton
          >
        </div>
        <UiFlash v-if="proposalError" tone="danger">{{ proposalError }}</UiFlash>
        <UiSkeleton v-if="proposalsLoading && !proposals.length" :count="3" />
        <UiEmptyState
          v-else-if="!proposalError && !proposals.length"
          :title="t('outstanding.noSuggestionsWithThisStatus')"
          :description="t('outstanding.whileARequestAwaitsCleanup')"
        />
        <VirtualList
          v-else-if="!proposalError"
          :items="proposals"
          :enabled="proposals.length > 3"
          max-height="440px"
          :estimate-item-height="240"
          :label="t('outstanding.suggestionList')"
        >
          <template #default="{ item }">
            <UiBoxRow :title="item.itemText" class="outstanding-cleanup__proposal">
              <template #leading
                ><UiCheckbox
                  v-if="item.reviewStatus === 'pending'"
                  :model-value="selectedIds.includes(item.id)"
                  :label="t('outstanding.selectSuggestion', { itemText: item.itemText })"
                  :disabled="busy || !canReview"
                  @update:model-value="selectProposal(item.id, $event)"
              /></template>
              <template #labels
                ><StatusLabel :status="outstandingItemStatusVisual[item.status]" /><StatusLabel
                  :status="outstandingCleanupProposalVisual[item.reviewStatus]"
              /></template>
              <p class="outstanding-cleanup__reason">{{ item.reason }}</p>
              <UiFlash v-if="item.stale && item.reviewStatus === 'pending'" tone="attention">{{
                staleMessage
              }}</UiFlash>
              <div class="outstanding-cleanup__actions">
                <UiButton size="sm" @click="openSession(item.sourceSessionId)">{{
                  t("common.sourceSession")
                }}</UiButton>
                <UiButton v-for="(id, index) in item.evidenceSessionIds" :key="id" size="sm" @click="openSession(id)">{{
                  t("outstanding.evidence", { value: index + 1 })
                }}</UiButton>
                <UiButton
                  v-if="item.reviewStatus === 'pending'"
                  size="sm"
                  :disabled="busy || !canReview || item.stale"
                  @click="decide([item.id], 'accept')"
                  >{{ t("outstanding.acceptSuggestion") }}</UiButton
                >
                <UiButton
                  v-if="item.reviewStatus === 'pending'"
                  size="sm"
                  :disabled="busy || !canReview"
                  @click="decide([item.id], 'reject')"
                  >{{ t("outstanding.rejectSuggestion") }}</UiButton
                >
              </div>
            </UiBoxRow>
          </template>
        </VirtualList>
        <template #footer
          ><UiPagination
            v-model:page-size="proposalPageSize"
            :page-info="proposalPageInfo"
            :size-label="t('outstanding.suggestionsPerPage')"
            @page="proposalPage = $event"
        /></template>
      </UiBox>
    </div>
  </UiSidePanel>
</template>

<style scoped>
.outstanding-cleanup__entry,
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
.outstanding-cleanup__body > .outstanding-cleanup__actions {
  margin-bottom: var(--space-4);
}
.outstanding-cleanup__hint {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
.outstanding-cleanup__summary,
.outstanding-cleanup__batch {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-xs);
}
.outstanding-cleanup__body .is-selected {
  background: var(--bg-subtle);
}
.outstanding-cleanup__reason {
  margin: var(--space-2) 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.outstanding-cleanup__proposal :deep(.ui-box-row__title) {
  white-space: normal;
  overflow-wrap: anywhere;
}
@media (max-width: 639px) {
  .outstanding-cleanup__body {
    padding: var(--space-2);
  }
}
</style>

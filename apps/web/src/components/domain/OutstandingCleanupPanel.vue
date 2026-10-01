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
    ? "整理請求已取消，既有建議僅供查閱；未結項保持原狀。"
    : "項目、來源或證據已變更；請核對後拒絕建議，再建立新的整理請求。",
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
      title: "建立整理未結項請求？",
      message: "Agent 會核對此專案未結項與後續工作紀錄，提出附證據的建議。你接受前，項目保持原狀。",
      confirmLabel: "建立整理請求",
      cancelLabel: "取消",
    }))
  )
    return;
  busy.value = true;
  createKey.value ||= crypto.randomUUID();
  try {
    await cleanupStore.createRequest(createKey.value);
    createKey.value = "";
    showToast("已建立整理請求，可請 Agent 整理此專案未結項。", "success");
  } catch (error) {
    showToast(errorMessage(error, "無法建立整理請求。"), "danger");
  } finally {
    busy.value = false;
  }
}
async function decide(ids: string[], decision: "accept" | "reject"): Promise<void> {
  if (busy.value || !ids.length) return;
  const accept = decision === "accept";
  if (
    !(await confirmAction({
      title: accept ? "接受整理建議？" : "拒絕整理建議？",
      message: accept
        ? `接受這 ${ids.length} 項建議後，未結項會標記為建議狀態並保存證據。項目或證據已變更時，整批不會套用。`
        : `拒絕這 ${ids.length} 項建議，未結項保持原狀。`,
      confirmLabel: accept ? "確認接受" : "確認拒絕",
      cancelLabel: "返回核對",
    }))
  )
    return;
  busy.value = true;
  try {
    await cleanupStore.decide(ids, decision);
    selectedIds.value = [];
    showToast(accept ? "已接受整理建議。" : "已拒絕整理建議，未結項保持原狀。", "success");
  } catch (error) {
    showToast(errorMessage(error, "無法審核整理建議。"), "danger");
  } finally {
    busy.value = false;
  }
}
async function cancelRequest(): Promise<void> {
  if (
    busy.value ||
    !(await confirmAction({
      title: "取消這份整理請求？",
      message: "既有建議保留供查閱，未結項保持原狀；之後可以建立新的整理請求。",
      confirmLabel: "取消整理請求",
      cancelLabel: "保留請求",
    }))
  )
    return;
  busy.value = true;
  try {
    await cleanupStore.cancelRequest();
    showToast("已取消整理請求。", "success");
  } catch (error) {
    showToast(errorMessage(error, "無法取消整理請求。"), "danger");
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
watch([requestId, reviewStatus, proposalPage, proposalPageSize, proposals], () => {
  selectedIds.value = [];
});

onBeforeUnmount(() => cleanupStore.setActive(false));
</script>

<template>
  <div class="outstanding-cleanup__entry">
    <UiButton size="sm" :icon="ListChecks" :disabled="!projectId" @click="panelMode = 'review'">整理未結項</UiButton>
    <span v-if="!projectId" class="outstanding-cleanup__hint">先選擇一個專案</span>
  </div>
  <UiSidePanel :open="isOpen" label="整理未結項" :width="720" @close="close">
    <template #header>
      <h2>整理未結項</h2>
      <UiButton size="sm" :icon="X" icon-only label="關閉整理未結項" @click="close" />
    </template>
    <div class="outstanding-cleanup__body">
      <p class="outstanding-cleanup__hint">先請 Agent 整理這個專案的未結項，再核對理由與證據。接受前，項目保持原狀。</p>
      <div class="outstanding-cleanup__actions">
        <UiButton variant="primary" :disabled="busy || loading || skipped || hasActiveRequest" @click="createRequest"
          >建立整理請求</UiButton
        >
        <UiButton :icon="RefreshCw" :disabled="busy" @click="cleanupStore.reload">重新整理</UiButton>
      </div>
      <UiFlash v-if="skipped" tone="accent">此專案目前未啟用記錄，整理請求無法讀取或建立。</UiFlash>
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiBox>
        <template #header><UiBoxTitle title="整理請求" :count="requestPageInfo.total" /></template>
        <UiSkeleton v-if="loading && !requests.length" :count="2" />
        <UiEmptyState
          v-else-if="!error && !requests.length"
          title="尚無整理請求"
          description="建立請求後，可請 Agent 核對此專案未結項。"
        />
        <VirtualList
          v-else-if="!error"
          :items="requests"
          :enabled="requests.length > 3"
          max-height="240px"
          label="整理請求清單"
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
              <template #meta
                >已核對 {{ item.examinedCount }} / {{ item.itemCount }} 項 ·
                {{ item.pendingProposalCount }} 項待審</template
              >
            </UiBoxRow>
          </template>
        </VirtualList>
        <template #footer
          ><UiPagination
            v-model:page-size="requestPageSize"
            :page-info="requestPageInfo"
            size-label="整理請求每頁筆數"
            @page="requestPage = $event"
        /></template>
      </UiBox>
      <UiBox v-if="requestId">
        <template #header>
          <UiBoxTitle title="整理建議" :count="proposalPageInfo.total" />
          <UiActionMenu
            v-model="reviewStatus"
            label="審核狀態"
            header="篩選整理建議"
            :items="reviewOptions"
            default-value="pending"
          />
        </template>
        <div v-if="selectedRequest" class="outstanding-cleanup__summary">
          <StatusLabel :status="outstandingCleanupRequestVisual[selectedRequest.status]" />
          <span>已核對 {{ selectedRequest.examinedCount }} / {{ selectedRequest.itemCount }} 項</span>
          <span>未提建議的項目保持未處理。</span>
          <UiButton v-if="canReview" size="sm" :disabled="busy" @click="cancelRequest">取消整理請求</UiButton>
        </div>
        <div
          v-if="reviewStatus === 'pending' && pendingProposals.length"
          class="outstanding-cleanup__actions outstanding-cleanup__batch"
          role="group"
          aria-label="批次審核整理建議"
        >
          <UiCheckbox
            v-model="allSelected"
            label="選取本頁全部整理建議"
            :indeterminate="selectedIds.length > 0 && !allSelected"
            :disabled="busy || !canReview"
          />
          <span aria-live="polite">已選取 {{ selectedIds.length }} 項</span>
          <UiButton
            size="sm"
            :disabled="busy || !canReview || !selectedIds.length || hasStaleSelection"
            @click="decide([...selectedIds], 'accept')"
            >接受選取</UiButton
          >
          <UiButton
            size="sm"
            :disabled="busy || !canReview || !selectedIds.length"
            @click="decide([...selectedIds], 'reject')"
            >拒絕選取</UiButton
          >
        </div>
        <UiFlash v-if="proposalError" tone="danger">{{ proposalError }}</UiFlash>
        <UiSkeleton v-if="proposalsLoading && !proposals.length" :count="3" />
        <UiEmptyState
          v-else-if="!proposalError && !proposals.length"
          title="目前沒有這個狀態的建議"
          description="請求待整理時，可請 Agent 整理此專案未結項；證據不足的項目不會產生建議。"
        />
        <VirtualList
          v-else-if="!proposalError"
          :items="proposals"
          :enabled="proposals.length > 3"
          max-height="440px"
          :estimate-item-height="240"
          label="整理建議清單"
        >
          <template #default="{ item }">
            <UiBoxRow :title="item.itemText" class="outstanding-cleanup__proposal">
              <template #leading
                ><UiCheckbox
                  v-if="item.reviewStatus === 'pending'"
                  :model-value="selectedIds.includes(item.id)"
                  :label="`選取整理建議：${item.itemText}`"
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
                <UiButton size="sm" @click="openSession(item.sourceSessionId)">來源 Session</UiButton>
                <UiButton v-for="(id, index) in item.evidenceSessionIds" :key="id" size="sm" @click="openSession(id)"
                  >證據 {{ index + 1 }}</UiButton
                >
                <UiButton
                  v-if="item.reviewStatus === 'pending'"
                  size="sm"
                  :disabled="busy || !canReview || item.stale"
                  @click="decide([item.id], 'accept')"
                  >接受建議</UiButton
                >
                <UiButton
                  v-if="item.reviewStatus === 'pending'"
                  size="sm"
                  :disabled="busy || !canReview"
                  @click="decide([item.id], 'reject')"
                  >拒絕建議</UiButton
                >
              </div>
            </UiBoxRow>
          </template>
        </VirtualList>
        <template #footer
          ><UiPagination
            v-model:page-size="proposalPageSize"
            :page-info="proposalPageInfo"
            size-label="整理建議每頁筆數"
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

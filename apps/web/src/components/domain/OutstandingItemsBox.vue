<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ListChecks } from "lucide-vue-next";
import type { OutstandingItem, OutstandingItemStatus, PageInfo, ProjectRecord } from "@work-intelligence/core";
import OutstandingCleanupPanel from "./OutstandingCleanupPanel.vue";
import StatusLabel from "./StatusLabel.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiDateRangeMenu from "../ui/UiDateRangeMenu.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { confirmAction } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { useOutstandingItemsStore } from "../../stores/outstanding-items";
import { errorMessage, formatDate, formatRelative } from "../../utils/format";
import { outstandingItemStatusLabels, type ListPageSize } from "../../utils/labels";
import { outstandingItemStatusVisual } from "../../utils/status";
import { t } from "../../i18n";

/** Filters, paginates, and updates the tracked Session nextSteps queue. */
const props = defineProps<{
  items: OutstandingItem[];
  projects: ProjectRecord[];
  pageInfo: PageInfo;
  loading: boolean;
  loaded: boolean;
  error: string;
}>();
const emit = defineEmits<{ retry: []; openSession: [sessionId: string]; showSessions: [] }>();
const projectId = defineModel<string>("projectId", { required: true });
const status = defineModel<OutstandingItemStatus>("status", { required: true });
const page = defineModel<number>("page", { required: true });
const pageSize = defineModel<ListPageSize>("pageSize", { required: true });
const from = defineModel<string>("from", { required: true });
const to = defineModel<string>("to", { required: true });

const outstandingItemsStore = useOutstandingItemsStore();
const { showToast } = useToast();

const changingItemIds = ref<string[]>([]);
const selectedIds = ref<string[]>([]);
const batchBusy = ref(false);
const undoBatch = ref<{ itemIds: string[]; status: OutstandingItemStatus }>();

const allSelected = computed({
  get: () => props.items.length > 0 && selectedIds.value.length === props.items.length,
  set: (selected: boolean) => {
    selectedIds.value = selected ? props.items.slice(0, 100).map((item) => item.id) : [];
  },
});
const dateRange = computed({
  get: () => ({ from: from.value, to: to.value }),
  set: (range) => {
    from.value = range.from;
    to.value = range.to;
  },
});

const projectOptions = computed(() => [
  { value: "", label: t("所有記錄中專案") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const statusOptions = (Object.keys(outstandingItemStatusLabels) as OutstandingItemStatus[]).map((value) => ({
  value,
  label: outstandingItemStatusLabels[value],
  icon: outstandingItemStatusVisual[value].icon,
  tone: outstandingItemStatusVisual[value].tone,
}));
const emptyTitle = computed(() =>
  status.value === "pending"
    ? t("目前沒有待處理未結項")
    : t("目前沒有「{value}」項目", { value: outstandingItemStatusLabels[status.value] }),
);
const hasFilters = computed(
  () => projectId.value !== "" || status.value !== "pending" || Boolean(from.value || to.value),
);

function clearFilters(): void {
  projectId.value = "";
  status.value = "pending";
  from.value = "";
  to.value = "";
  page.value = 1;
}

async function updateItemStatus(item: OutstandingItem, nextStatus: OutstandingItemStatus): Promise<void> {
  if (changingItemIds.value.includes(item.id)) return;
  if (nextStatus === "not_needed") {
    const confirmed = await confirmAction({
      title: t("將這項未結項標記為不再需要？"),
      message: t("「{text}」會從待處理清單移除，但仍可在「不再需要」篩選中查看並重新開啟。", { text: item.text }),
      confirmLabel: t("標記不再需要"),
      cancelLabel: t("保留為待處理"),
    });
    if (!confirmed) return;
  }

  changingItemIds.value = [...changingItemIds.value, item.id];
  try {
    await outstandingItemsStore.updateStatus({ itemId: item.id, status: nextStatus });
    const message =
      nextStatus === "pending"
        ? t("已重新開啟這項未結項。")
        : nextStatus === "completed"
          ? t("已標記為完成。")
          : t("已標記為不再需要。");
    showToast(message, "success");
  } catch (error) {
    showToast(errorMessage(error, t("無法更新未結項，請稍後再試。")), "danger");
  } finally {
    changingItemIds.value = changingItemIds.value.filter((id) => id !== item.id);
  }
}

async function updateBatch(nextStatus: "completed" | "not_needed"): Promise<void> {
  if (batchBusy.value || status.value !== "pending" || selectedIds.value.length === 0) return;
  const itemIds = [...selectedIds.value];
  if (
    nextStatus === "not_needed" &&
    !(await confirmAction({
      title: t("批次不再需要"),
      message: t("將選取的 {length} 項標記為不再需要，仍可從狀態篩選查看並重新開啟。", { length: itemIds.length }),
      confirmLabel: t("標記不再需要"),
      cancelLabel: t("保留目前狀態"),
    }))
  )
    return;
  batchBusy.value = true;
  try {
    const result = await outstandingItemsStore.batchUpdateStatus({
      itemIds,
      status: nextStatus,
      expectedStatus: "pending",
    });
    undoBatch.value = result.updatedItemIds.length ? { itemIds: result.updatedItemIds, status: nextStatus } : undefined;
    selectedIds.value = [];
    showToast(t("已更新 {length} 項未結項。", { length: result.updatedItemIds.length }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("無法批次更新未結項，請稍後再試。")), "danger");
  } finally {
    batchBusy.value = false;
  }
}

async function restoreBatch(): Promise<void> {
  const batch = undoBatch.value;
  if (!batch || batchBusy.value) return;
  batchBusy.value = true;
  try {
    await outstandingItemsStore.batchUpdateStatus({
      itemIds: batch.itemIds,
      status: "pending",
      expectedStatus: batch.status,
    });
    undoBatch.value = undefined;
    showToast(t("已將 {length} 項復原為待處理。", { length: batch.itemIds.length }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("無法復原，請重新整理並確認項目狀態。")), "danger");
  } finally {
    batchBusy.value = false;
  }
}

function selectItem(itemId: string, selected: boolean): void {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, itemId])].slice(0, 100)
    : selectedIds.value.filter((id) => id !== itemId);
}

function isChanging(item: OutstandingItem): boolean {
  return batchBusy.value || changingItemIds.value.includes(item.id);
}

watch([projectId, status, pageSize, page, from, to], () => {
  selectedIds.value = [];
});

watch(
  () => props.items,
  (items) => {
    // A same-page SSE refresh keeps eligible selections instead of undoing a user's click.
    const eligibleIds = new Set(items.filter((item) => item.status === "pending").map((item) => item.id));
    selectedIds.value = selectedIds.value.filter((id) => eligibleIds.has(id));
  },
);
</script>

<template>
  <UiBox sticky-header data-testid="outstanding-items-box">
    <template #header>
      <UiBoxTitle :icon="ListChecks" :title="t('未結項')" :count="pageInfo.total" />
      <div class="outstanding-items__filters">
        <UiActionMenu
          v-model="projectId"
          :label="t('專案')"
          :header="t('篩選專案')"
          default-value=""
          align="end"
          :items="projectOptions"
        />
        <UiActionMenu
          v-model="status"
          :label="t('狀態')"
          :header="t('篩選未結項狀態')"
          default-value="pending"
          align="end"
          :items="statusOptions"
        />
        <UiDateRangeMenu v-model="dateRange" :label="t('來源 Session 日期')" />
        <OutstandingCleanupPanel @open-session="emit('openSession', $event)" />
      </div>
    </template>

    <div class="outstanding-items__batch" role="group" :aria-label="t('批次操作')">
      <UiCheckbox
        v-model="allSelected"
        :label="t('選取本頁全部未結項')"
        :indeterminate="selectedIds.length > 0 && !allSelected"
        :disabled="status !== 'pending' || loading || batchBusy || changingItemIds.length > 0 || items.length === 0"
      />
      <span aria-live="polite">{{ t("已選取 {length} 項", { length: selectedIds.length }) }}</span>
      <UiButton
        size="sm"
        :disabled="
          status !== 'pending' || selectedIds.length === 0 || batchBusy || changingItemIds.length > 0 || loading
        "
        @click="updateBatch('completed')"
        >{{ t("批次標記完成") }}</UiButton
      >
      <UiButton
        size="sm"
        :disabled="
          status !== 'pending' || selectedIds.length === 0 || batchBusy || changingItemIds.length > 0 || loading
        "
        @click="updateBatch('not_needed')"
        >{{ t("批次不再需要") }}</UiButton
      >
      <UiButton v-if="undoBatch" size="sm" :disabled="batchBusy || changingItemIds.length > 0" @click="restoreBatch">{{
        t("復原本次批次")
      }}</UiButton>
    </div>

    <UiFlash v-if="error" tone="danger" data-testid="outstanding-items-error">
      {{ error }}
      <template #actions
        ><UiButton size="sm" @click="emit('retry')">{{ t("重試") }}</UiButton></template
      >
    </UiFlash>
    <UiSkeleton
      v-if="loading && !loaded"
      :count="4"
      :label="t('正在載入未結項…')"
      data-testid="outstanding-items-loading"
    />
    <UiEmptyState
      v-else-if="loaded && !error && items.length === 0"
      :icon="ListChecks"
      :title="emptyTitle"
      :description="t('完成的 Session 中回報的 nextSteps 會自動列在這裡；可以依專案篩選，並更新追蹤狀態。')"
      data-testid="outstanding-items-empty"
    >
      <template #action>
        <UiButton v-if="hasFilters" @click="clearFilters">{{ t("清除篩選") }}</UiButton>
        <UiButton v-else @click="emit('showSessions')">{{ t("返回工作歷程") }}</UiButton>
      </template>
    </UiEmptyState>
    <VirtualList
      v-else-if="!error && items.length > 0"
      :items="items"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :label="t('未結項清單')"
    >
      <template #default="{ item }">
        <UiBoxRow data-testid="outstanding-item">
          <template #leading>
            <UiCheckbox
              :model-value="selectedIds.includes(item.id)"
              :label="t('選取未結項：{text}', { text: item.text })"
              :disabled="item.status !== 'pending' || loading || isChanging(item) || changingItemIds.length > 0"
              @update:model-value="selectItem(item.id, $event)"
            />
          </template>
          <template #title>{{ item.text }}</template>
          <template #meta>
            <span>{{ item.projectName }}</span>
            ·
            <!-- This action opens the source Session panel while preserving the current filters. -->
            <button
              type="button"
              class="outstanding-items__source"
              :aria-label="t('開啟來源 Session：{sourceSessionTitle}', { sourceSessionTitle: item.sourceSessionTitle })"
              @click="emit('openSession', item.sourceSessionId)"
            >
              {{ item.sourceSessionTitle }}
            </button>
            ·
            <time :datetime="item.sourceSessionCompletedAt" :title="formatDate(item.sourceSessionCompletedAt)">{{
              formatRelative(item.sourceSessionCompletedAt)
            }}</time>
          </template>
          <template #trailing>
            <div class="outstanding-items__trailing">
              <StatusLabel :status="outstandingItemStatusVisual[item.status]" />
              <div class="outstanding-items__actions">
                <template v-if="item.status === 'pending'">
                  <UiButton
                    size="sm"
                    :loading="isChanging(item)"
                    :disabled="isChanging(item)"
                    @click="updateItemStatus(item, 'completed')"
                    >{{ t("標記完成") }}</UiButton
                  >
                  <UiButton
                    size="sm"
                    :loading="isChanging(item)"
                    :disabled="isChanging(item)"
                    @click="updateItemStatus(item, 'not_needed')"
                    >{{ t("不再需要") }}</UiButton
                  >
                </template>
                <UiButton
                  v-else
                  size="sm"
                  :loading="isChanging(item)"
                  :disabled="isChanging(item)"
                  @click="updateItemStatus(item, 'pending')"
                  >{{ t("重新開啟") }}</UiButton
                >
              </div>
            </div>
          </template>
        </UiBoxRow>
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination
        v-model:page-size="pageSize"
        :page-info="pageInfo"
        :size-label="t('未結項每頁筆數')"
        @page="page = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.outstanding-items__batch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.outstanding-items__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.outstanding-items__source {
  position: relative;
  z-index: 1;
  max-width: min(32rem, 55vw);
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.outstanding-items__source:hover {
  text-decoration: underline;
}

.outstanding-items__trailing {
  display: grid;
  justify-items: end;
  gap: var(--space-2);
}

.outstanding-items__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
}

@media (max-width: 639px) {
  .outstanding-items__trailing {
    max-width: 8.5rem;
  }

  .outstanding-items__actions :deep(.ui-button) {
    padding-inline: var(--space-1);
  }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, CircleSlash, ListChecks, RotateCcw } from "lucide-vue-next";
import type { OutstandingItem, OutstandingItemStatus, PageInfo } from "@work-intelligence/core";
import OutstandingCleanupPanel from "./OutstandingCleanupPanel.vue";
import ProjectFilterMenu from "./ProjectFilterMenu.vue";
import StatusLabel from "./StatusLabel.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiDateRangeMenu from "../ui/UiDateRangeMenu.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFilterChips from "../ui/UiFilterChips.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSelectionBar from "../ui/UiSelectionBar.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import type { FilterChip } from "../ui/types";
import { useFocusRestore } from "../../composables/useFocusRestore";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { useProjectChip } from "../../composables/useProjectChip";
import { useRowSelection } from "../../composables/useRowSelection";
import { useToast } from "../../composables/useToast";
import { useOutstandingItemsStore, type OutstandingClosedFilter } from "../../stores/outstanding-items";
import { errorMessage, formatDate, formatDateRangeText, formatRelative } from "../../utils/format";
import { outstandingItemStatusLabels, type ListPageSize } from "../../utils/labels";
import { outstandingItemStatusVisual } from "../../utils/status";
import { filterChip } from "../../utils/filter-chips";
import { t } from "../../i18n";

const props = defineProps<{
  items: OutstandingItem[];
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
const closedFilter = defineModel<OutstandingClosedFilter>("closedFilter", { required: true });

const outstandingItemsStore = useOutstandingItemsStore();
const { showToast } = useToast();
const narrow = useMediaQuery("(max-width: 639px)");
const { selectedIds, allSelected, clearSelection, selectItem, dropFromSelection } = useRowSelection(
  () => props.items.filter((item) => item.status === "pending").map((item) => item.id),
  { onClear: resetSelectionScope },
);
const { boxRef, listRef, restoreFocus, settleFocus } = useFocusRestore({
  rowIdAttribute: "data-item-id",
  actionSelector: ".outstanding-items__actions button",
});

const projectChip = useProjectChip(projectId);

const changingItemIds = ref<string[]>([]);
const selectedAcrossPages = ref(false);
const selectingAll = ref(false);
const batchBusy = ref(false);
let selectionEpoch = 0;
let selectAbort: AbortController | undefined;

const canSelectAllMatching = computed(
  () => allSelected.value && !selectedAcrossPages.value && props.pageInfo.total > selectedIds.value.length,
);
const selectionSummary = computed(() => {
  const count = selectedIds.value.length;
  if (selectedAcrossPages.value && count === props.pageInfo.total) return t("outstanding.selectedAll", { count });
  if (allSelected.value && !selectedAcrossPages.value) return t("outstanding.selectedPage", { count });
  return t("outstanding.selectedCount", { count });
});
const selectionBusy = computed(() => batchBusy.value || selectingAll.value || changingItemIds.value.length > 0);
const dateRange = computed({
  get: () => ({ from: from.value, to: to.value }),
  set: (range) => {
    from.value = range.from;
    to.value = range.to;
  },
});

const statusOptions = (Object.keys(outstandingItemStatusLabels) as OutstandingItemStatus[]).map((value) => ({
  value,
  label: outstandingItemStatusLabels[value],
  icon: outstandingItemStatusVisual[value].icon,
  tone: outstandingItemStatusVisual[value].tone,
}));
const closedFilterOptions = computed(() => [
  { value: "all", label: t("outstanding.closedFilterAll") },
  { value: "hide_source_session", label: t("outstanding.closedFilterHideSource") },
]);
const emptyTitle = computed(() =>
  status.value === "pending"
    ? t("outstanding.noPendingOpenItems")
    : t("outstanding.noItemsRightNow", { value: outstandingItemStatusLabels[status.value] }),
);
const hasFilters = computed(
  () =>
    projectId.value !== "" ||
    status.value !== "pending" ||
    closedFilter.value !== "all" ||
    Boolean(from.value || to.value),
);
const filterChips = computed(() => {
  const chips: FilterChip[] = [];
  if (projectChip.value) chips.push(projectChip.value);
  if (status.value !== "pending") {
    chips.push(filterChip("status", t("common.status"), outstandingItemStatusLabels[status.value]));
  }
  if (status.value !== "pending" && closedFilter.value !== "all") {
    const closed = closedFilterOptions.value.find((option) => option.value === closedFilter.value);
    chips.push(filterChip("closed", t("outstanding.closedFilterLabel"), closed?.label ?? closedFilter.value));
  }
  if (from.value || to.value) {
    chips.push(filterChip("date", t("outstanding.sourceSessionDate"), formatDateRangeText(dateRange.value)));
  }
  return chips;
});

function removeFilter(key: string): void {
  if (key === "project") projectId.value = "";
  else if (key === "status") status.value = "pending";
  else if (key === "closed") closedFilter.value = "all";
  else dateRange.value = { from: "", to: "" };
}

function clearFilters(): void {
  projectId.value = "";
  status.value = "pending";
  from.value = "";
  to.value = "";
  closedFilter.value = "all";
  page.value = 1;
}

function resetSelectionScope(): void {
  selectionEpoch += 1;
  selectAbort?.abort();
  selectedAcrossPages.value = false;
}

async function undoStatus(
  itemIds: string[],
  applied: OutstandingItemStatus,
  previous: OutstandingItemStatus,
): Promise<void> {
  const result = await outstandingItemsStore.batchUpdateStatusInChunks({
    itemIds,
    status: previous,
    expectedStatus: applied,
  });
  const updated = result.updatedItemIds.length;
  const skipped = result.skippedItemIds.length;
  if (skipped > 0) showToast(t("outstanding.undoneAndSkipped", { updated, skipped }), "default");
  else if (updated > 0) showToast(t("outstanding.undone", { count: updated }), "success");
  if (result.failure) showToast(errorMessage(result.failure, t("outstanding.couldNotUndoRefreshAnd")), "danger");
  await restoreFocus();
}

async function updateItemStatus(item: OutstandingItem, nextStatus: OutstandingItemStatus): Promise<void> {
  if (changingItemIds.value.includes(item.id)) return;
  const previous = item.status;
  const nextItemId = props.items[props.items.findIndex((candidate) => candidate.id === item.id) + 1]?.id;
  changingItemIds.value = [...changingItemIds.value, item.id];
  try {
    // The batch endpoint is the one that checks the status the row was showing.
    const result = await outstandingItemsStore.batchUpdateStatusInChunks({
      itemIds: [item.id],
      status: nextStatus,
      expectedStatus: previous,
    });
    if (result.failure) {
      showToast(errorMessage(result.failure, t("outstanding.couldNotUpdateTheOpenItemPleaseTry")), "danger");
      return;
    }
    dropFromSelection([item.id]);
    if (result.skippedItemIds.length > 0) {
      showToast(t("outstanding.itemNoLongerPending"), "default");
    } else {
      const message =
        nextStatus === "pending"
          ? t("outstanding.openItemReopened")
          : nextStatus === "completed"
            ? t("outstanding.markedAsDone")
            : t("outstanding.markedAsNoLongerNeeded");
      // Undoing a reopen would record the user as the closer, so only a user's own close can be put back.
      const undoable = nextStatus !== "pending" || item.closedBy === "user";
      showToast(
        message,
        "success",
        undoable ? { label: t("common.undo"), run: () => undoStatus([item.id], nextStatus, previous) } : undefined,
      );
    }
    await restoreFocus(nextItemId);
  } finally {
    changingItemIds.value = changingItemIds.value.filter((id) => id !== item.id);
  }
}

async function updateBatch(nextStatus: "completed" | "not_needed"): Promise<void> {
  if (selectionBusy.value || status.value !== "pending" || selectedIds.value.length === 0) return;
  const itemIds = [...selectedIds.value];
  batchBusy.value = true;
  try {
    const result = await outstandingItemsStore.batchUpdateStatusInChunks({
      itemIds,
      status: nextStatus,
      expectedStatus: "pending",
    });
    dropFromSelection([...result.updatedItemIds, ...result.skippedItemIds]);
    const { updatedItemIds } = result;
    const undo = updatedItemIds.length
      ? { label: t("common.undo"), run: () => undoStatus(updatedItemIds, nextStatus, "pending") }
      : undefined;
    if (result.failure) {
      const reason = errorMessage(result.failure, t("outstanding.couldNotUpdateTheOpen"));
      showToast(
        t("outstanding.partiallyUpdated", { updated: updatedItemIds.length, total: itemIds.length, reason }),
        "danger",
        undo,
      );
    } else if (result.skippedItemIds.length > 0) {
      const counts = { updated: updatedItemIds.length, skipped: result.skippedItemIds.length };
      showToast(t("outstanding.updatedAndSkipped", counts), "default", undo);
    } else {
      showToast(t("outstanding.updatedOpenItems", { length: updatedItemIds.length }), "success", undo);
    }
    await restoreFocus();
  } finally {
    batchBusy.value = false;
  }
}

async function selectAllMatching(): Promise<void> {
  if (selectingAll.value) return;
  const epoch = selectionEpoch;
  selectAbort = new AbortController();
  selectingAll.value = true;
  try {
    const ids = await outstandingItemsStore.listAllPendingIds(selectAbort.signal);
    if (epoch !== selectionEpoch) return;
    selectedIds.value = ids;
    selectedAcrossPages.value = true;
  } catch (error) {
    if (epoch === selectionEpoch) showToast(errorMessage(error, t("outstanding.couldNotLoadOpenItems")), "danger");
  } finally {
    selectingAll.value = false;
  }
}

function closedByLabel(item: OutstandingItem): string | undefined {
  if (item.status === "pending") return undefined;
  if (item.closedBy === "later_session") return t("outstanding.closedByLaterSession");
  if (item.closedBy === "source_session" && item.status === "not_needed") return t("outstanding.closedBySourceSession");
  return undefined;
}

function isChanging(item: OutstandingItem): boolean {
  return batchBusy.value || changingItemIds.value.includes(item.id);
}

watch([projectId, status, from, to, closedFilter], clearSelection);

watch(() => props.items, settleFocus, { flush: "post" });

watch([page, pageSize], () => {
  if (!selectedAcrossPages.value) clearSelection();
});

watch(
  () => props.items,
  (items) => {
    const visibleIds = new Set(items.map((item) => item.id));
    const pendingIds = new Set(items.filter((item) => item.status === "pending").map((item) => item.id));
    // A same-page SSE refresh keeps eligible selections instead of undoing a user's click. Across pages, ids that are
    // not on screen cannot be checked, so only the visible ones that stopped being pending are dropped.
    selectedIds.value = selectedIds.value.filter((id) =>
      selectedAcrossPages.value ? pendingIds.has(id) || !visibleIds.has(id) : pendingIds.has(id),
    );
    if (selectedAcrossPages.value && selectedIds.value.length === 0) clearSelection();
  },
);

onBeforeUnmount(() => selectAbort?.abort());
</script>

<template>
  <UiBox ref="boxRef" sticky-header data-testid="outstanding-items-box">
    <template #header>
      <UiBoxTitle :icon="ListChecks" :title="t('common.openItems')" :count="loaded ? pageInfo.total : undefined" />
      <div class="outstanding-items__filters">
        <ProjectFilterMenu v-model="projectId" :header="t('common.filterProject')" align="end" scope="all" />
        <UiActionMenu
          v-model="status"
          :label="t('common.status')"
          :header="t('outstanding.filterOpenItemStatus')"
          default-value="pending"
          align="end"
          :items="statusOptions"
        />
        <UiActionMenu
          v-if="status === 'not_needed'"
          v-model="closedFilter"
          :label="t('outstanding.closedFilterLabel')"
          :header="t('outstanding.filterClosedBy')"
          default-value="all"
          align="end"
          :items="closedFilterOptions"
        />
        <UiDateRangeMenu v-model="dateRange" :label="t('outstanding.sourceSessionDate')" />
        <OutstandingCleanupPanel @open-session="emit('openSession', $event)" />
      </div>
    </template>

    <UiFilterChips :chips="filterChips" clearable @remove="removeFilter" @clear="clearFilters" />

    <UiSelectionBar
      v-if="status === 'pending' && items.length > 0"
      v-model="allSelected"
      :label="t('outstanding.selectAllOpenItemsOn')"
      :select-text="t('outstanding.selectPage')"
      :group-label="t('outstanding.bulkActions')"
      :summary="selectionSummary"
      :count="selectedIds.length"
      :indeterminate="selectedIds.length > 0 && !allSelected"
      :disabled="loading || selectionBusy"
      toolbar-testid="outstanding-batch-toolbar"
      summary-testid="outstanding-selection-summary"
    >
      <UiButton
        v-if="canSelectAllMatching"
        variant="link"
        size="sm"
        :loading="selectingAll"
        :disabled="selectionBusy"
        @click="selectAllMatching"
        >{{ t("outstanding.selectAllMatching", { count: pageInfo.total }) }}</UiButton
      >
      <UiButton variant="link" size="sm" :disabled="selectionBusy" @click="clearSelection">{{
        t("outstanding.clearSelection")
      }}</UiButton>
      <UiButton size="sm" :disabled="loading || selectionBusy" @click="updateBatch('completed')">{{
        t("outstanding.markDone")
      }}</UiButton>
      <UiButton size="sm" :disabled="loading || selectionBusy" @click="updateBatch('not_needed')">{{
        t("outstanding.markNotNeeded")
      }}</UiButton>
    </UiSelectionBar>

    <UiFlash v-if="error" tone="danger" data-testid="outstanding-items-error">
      {{ error }}
      <template #actions
        ><UiButton size="sm" @click="emit('retry')">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>
    <UiSkeleton
      v-if="loading && !loaded"
      :count="4"
      :label="t('outstanding.loadingOpenItems')"
      data-testid="outstanding-items-loading"
    />
    <UiEmptyState
      v-else-if="loaded && !error && items.length === 0"
      :icon="ListChecks"
      :title="emptyTitle"
      :description="t('outstanding.nextstepsReportedByCompletedSessions')"
      data-testid="outstanding-items-empty"
    >
      <template #action>
        <UiButton v-if="hasFilters" @click="clearFilters">{{ t("common.clearFilters") }}</UiButton>
        <UiButton v-else @click="emit('showSessions')">{{ t("outstanding.backToWorkHistory") }}</UiButton>
      </template>
    </UiEmptyState>
    <VirtualList
      v-else-if="!error && items.length > 0"
      ref="listRef"
      :items="items"
      :item-key="(item) => item.id"
      :enabled="!narrow"
      :fit-viewport="!narrow"
      :fit-viewport-to-panel="!narrow"
      :fill-available-space="!narrow"
      :label="t('outstanding.openItemsList')"
    >
      <template #default="{ item }">
        <UiBoxRow class="outstanding-items__row" data-testid="outstanding-item" :data-item-id="item.id">
          <template #leading>
            <UiCheckbox
              :model-value="selectedIds.includes(item.id)"
              :label="t('outstanding.selectOpenItem', { text: item.text })"
              :disabled="item.status !== 'pending' || loading || isChanging(item) || selectionBusy"
              @update:model-value="selectItem(item.id, $event)"
            />
          </template>
          <template #title
            ><span :title="item.text">{{ item.text }}</span></template
          >
          <template #labels>
            <StatusLabel v-if="item.status !== 'pending'" :status="outstandingItemStatusVisual[item.status]" />
            <UiLabel v-if="closedByLabel(item)" data-testid="outstanding-item-closed-by">{{
              closedByLabel(item)
            }}</UiLabel>
          </template>
          <template #meta>
            <span :title="item.projectName">{{ item.projectName }}</span>
            ·
            <!-- This action opens the source Session panel while preserving the current filters. -->
            <UiButton
              variant="link"
              truncate
              class="outstanding-items__source"
              :title="item.sourceSessionTitle"
              :aria-label="t('outstanding.openSourceSession', { sourceSessionTitle: item.sourceSessionTitle })"
              @click="emit('openSession', item.sourceSessionId)"
            >
              {{ item.sourceSessionTitle }}
            </UiButton>
            ·
            <time :datetime="item.sourceSessionCompletedAt" :title="formatDate(item.sourceSessionCompletedAt)">{{
              formatRelative(item.sourceSessionCompletedAt)
            }}</time>
          </template>
          <template #trailing>
            <div class="outstanding-items__actions">
              <template v-if="item.status === 'pending'">
                <UiButton
                  size="sm"
                  :icon="Check"
                  :icon-only="!narrow"
                  :label="t('outstanding.markDoneAction')"
                  :aria-label="t('outstanding.markDoneItem', { text: item.text })"
                  :loading="isChanging(item)"
                  :disabled="isChanging(item)"
                  @click="updateItemStatus(item, 'completed')"
                />
                <UiButton
                  size="sm"
                  :icon="CircleSlash"
                  :icon-only="!narrow"
                  :label="t('outstanding.markNotNeededAction')"
                  :aria-label="t('outstanding.markNotNeededItem', { text: item.text })"
                  :loading="isChanging(item)"
                  :disabled="isChanging(item)"
                  @click="updateItemStatus(item, 'not_needed')"
                />
              </template>
              <UiButton
                v-else
                size="sm"
                :icon="RotateCcw"
                :icon-only="!narrow"
                :label="t('outstanding.reopen')"
                :aria-label="t('outstanding.reopenItem', { text: item.text })"
                :loading="isChanging(item)"
                :disabled="isChanging(item)"
                @click="updateItemStatus(item, 'pending')"
              />
            </div>
          </template>
        </UiBoxRow>
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination
        v-model:page-size="pageSize"
        :page-info="pageInfo"
        :size-label="t('outstanding.openItemsPerPage')"
        @page="page = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.outstanding-items__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.outstanding-items__row {
  align-items: center;
  padding-block: var(--space-2);
}

.outstanding-items__row :deep(.ui-box-row__leading) {
  padding-top: 0;
}

.outstanding-items__row :deep(.ui-box-row__text) {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.outstanding-items__source {
  position: relative;
  z-index: 1;
  max-width: min(32rem, 55vw);
  vertical-align: bottom;
}

.outstanding-items__actions {
  display: flex;
  gap: var(--space-1);
}

@media (max-width: 639px) {
  .outstanding-items__row {
    flex-wrap: wrap;
  }

  .outstanding-items__row :deep(.ui-box-row__meta) {
    white-space: normal;
  }

  .outstanding-items__row :deep(.ui-box-row__trailing) {
    flex-basis: 100%;
    justify-content: flex-end;
  }
}
</style>

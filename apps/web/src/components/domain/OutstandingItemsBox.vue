<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import type { FilterChip } from "../ui/types";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { useProjectChip } from "../../composables/useProjectChip";
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

const projectChip = useProjectChip(projectId);

const changingItemIds = ref<string[]>([]);
const selectedIds = ref<string[]>([]);
const selectedAcrossPages = ref(false);
const selectingAll = ref(false);
const batchBusy = ref(false);
let selectionEpoch = 0;

const pendingItems = computed(() => props.items.filter((item) => item.status === "pending"));
const allSelected = computed({
  get: () => pendingItems.value.length > 0 && pendingItems.value.every((item) => selectedIds.value.includes(item.id)),
  set: (selected: boolean) => {
    if (selected) selectedIds.value = pendingItems.value.map((item) => item.id);
    else clearSelection();
  },
});
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

function clearSelection(): void {
  selectionEpoch += 1;
  selectedIds.value = [];
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
  if (result.updatedItemIds.length)
    showToast(t("outstanding.undone", { count: result.updatedItemIds.length }), "success");
  if (result.failure) showToast(errorMessage(result.failure, t("outstanding.couldNotUndoRefreshAnd")), "danger");
}

async function updateItemStatus(item: OutstandingItem, nextStatus: OutstandingItemStatus): Promise<void> {
  if (changingItemIds.value.includes(item.id)) return;
  const previous = item.status;
  changingItemIds.value = [...changingItemIds.value, item.id];
  try {
    await outstandingItemsStore.updateStatus({ itemId: item.id, status: nextStatus });
    const message =
      nextStatus === "pending"
        ? t("outstanding.openItemReopened")
        : nextStatus === "completed"
          ? t("outstanding.markedAsDone")
          : t("outstanding.markedAsNoLongerNeeded");
    showToast(message, "success", {
      label: t("common.undo"),
      run: () => undoStatus([item.id], nextStatus, previous),
    });
  } catch (error) {
    showToast(errorMessage(error, t("outstanding.couldNotUpdateTheOpenItemPleaseTry")), "danger");
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
    clearSelection();
    if (result.updatedItemIds.length) {
      const updatedItemIds = result.updatedItemIds;
      showToast(t("outstanding.updatedOpenItems", { length: updatedItemIds.length }), "success", {
        label: t("common.undo"),
        run: () => undoStatus(updatedItemIds, nextStatus, "pending"),
      });
    }
    if (result.failure) showToast(errorMessage(result.failure, t("outstanding.couldNotUpdateTheOpen")), "danger");
  } finally {
    batchBusy.value = false;
  }
}

async function selectAllMatching(): Promise<void> {
  if (selectingAll.value) return;
  const epoch = selectionEpoch;
  selectingAll.value = true;
  try {
    const ids = await outstandingItemsStore.listAllPendingIds();
    if (epoch !== selectionEpoch) return;
    selectedIds.value = ids;
    selectedAcrossPages.value = true;
  } catch (error) {
    showToast(errorMessage(error, t("outstanding.couldNotLoadOpenItems")), "danger");
  } finally {
    selectingAll.value = false;
  }
}

function selectItem(itemId: string, selected: boolean): void {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, itemId])]
    : selectedIds.value.filter((id) => id !== itemId);
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

watch([page, pageSize], () => {
  if (!selectedAcrossPages.value) clearSelection();
});

watch(
  () => props.items,
  (items) => {
    if (selectedAcrossPages.value) return;
    // A same-page SSE refresh keeps eligible selections instead of undoing a user's click.
    const eligibleIds = new Set(items.filter((item) => item.status === "pending").map((item) => item.id));
    selectedIds.value = selectedIds.value.filter((id) => eligibleIds.has(id));
  },
);
</script>

<template>
  <UiBox sticky-header data-testid="outstanding-items-box">
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

    <div v-if="status === 'pending' && items.length > 0" class="outstanding-items__selection">
      <UiCheckbox
        v-model="allSelected"
        :label="t('outstanding.selectAllOpenItemsOn')"
        :indeterminate="selectedIds.length > 0 && !allSelected"
        :disabled="loading || selectionBusy"
      />
      <span v-if="selectedIds.length === 0">{{ t("outstanding.selectPage") }}</span>
      <div
        v-else
        class="outstanding-items__batch"
        role="group"
        :aria-label="t('outstanding.bulkActions')"
        data-testid="outstanding-batch-toolbar"
      >
        <span aria-live="polite" data-testid="outstanding-selection-summary">{{ selectionSummary }}</span>
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
      </div>
    </div>

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
      :items="items"
      :item-key="(item) => item.id"
      :enabled="!narrow"
      :fit-viewport="!narrow"
      :fit-viewport-to-panel="!narrow"
      :fill-available-space="!narrow"
      :label="t('outstanding.openItemsList')"
    >
      <template #default="{ item }">
        <UiBoxRow class="outstanding-items__row" data-testid="outstanding-item">
          <template #leading>
            <UiCheckbox
              :model-value="selectedIds.includes(item.id)"
              :label="t('outstanding.selectOpenItem', { text: item.text })"
              :disabled="item.status !== 'pending' || loading || isChanging(item) || selectionBusy"
              @update:model-value="selectItem(item.id, $event)"
            />
          </template>
          <template #title>{{ item.text }}</template>
          <template #labels>
            <StatusLabel v-if="item.status !== 'pending'" :status="outstandingItemStatusVisual[item.status]" />
            <UiLabel v-if="closedByLabel(item)" data-testid="outstanding-item-closed-by">{{
              closedByLabel(item)
            }}</UiLabel>
          </template>
          <template #meta>
            <span>{{ item.projectName }}</span>
            ·
            <!-- This action opens the source Session panel while preserving the current filters. -->
            <UiButton
              variant="link"
              truncate
              class="outstanding-items__source"
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
                  :loading="isChanging(item)"
                  :disabled="isChanging(item)"
                  @click="updateItemStatus(item, 'completed')"
                />
                <UiButton
                  size="sm"
                  :icon="CircleSlash"
                  :icon-only="!narrow"
                  :label="t('outstanding.markNotNeededAction')"
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
.outstanding-items__selection {
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

.outstanding-items__batch {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

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

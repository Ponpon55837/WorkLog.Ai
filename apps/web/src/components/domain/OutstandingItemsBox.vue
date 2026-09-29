<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ListChecks } from "lucide-vue-next";
import type { OutstandingItem, OutstandingItemStatus, PageInfo, ProjectRecord } from "@work-intelligence/core";
import StatusLabel from "./StatusLabel.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
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

const outstandingItemsStore = useOutstandingItemsStore();
const { showToast } = useToast();

const changingItemIds = ref<string[]>([]);

const projectOptions = computed(() => [
  { value: "", label: "所有記錄中專案" },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const statusOptions = (Object.keys(outstandingItemStatusLabels) as OutstandingItemStatus[]).map((value) => ({
  value,
  label: outstandingItemStatusLabels[value],
  icon: outstandingItemStatusVisual[value].icon,
  tone: outstandingItemStatusVisual[value].tone,
}));
const emptyTitle = computed(() =>
  status.value === "pending" ? "目前沒有待處理未結項" : `目前沒有「${outstandingItemStatusLabels[status.value]}」項目`,
);
const hasFilters = computed(() => projectId.value !== "" || status.value !== "pending");

function clearFilters(): void {
  projectId.value = "";
  status.value = "pending";
  page.value = 1;
}

async function updateItemStatus(item: OutstandingItem, nextStatus: OutstandingItemStatus): Promise<void> {
  if (changingItemIds.value.includes(item.id)) return;
  if (nextStatus === "not_needed") {
    const confirmed = await confirmAction({
      title: "將這項未結項標記為不再需要？",
      message: `「${item.text}」會從待處理清單移除，但仍可在「不再需要」篩選中查看並重新開啟。`,
      confirmLabel: "標記不再需要",
      cancelLabel: "保留為待處理",
    });
    if (!confirmed) return;
  }

  changingItemIds.value = [...changingItemIds.value, item.id];
  try {
    await outstandingItemsStore.updateStatus({ itemId: item.id, status: nextStatus });
    const message =
      nextStatus === "pending"
        ? "已重新開啟這項未結項。"
        : nextStatus === "completed"
          ? "已標記為完成。"
          : "已標記為不再需要。";
    showToast(message, "success");
  } catch (error) {
    showToast(errorMessage(error, "無法更新未結項，請稍後再試。"), "danger");
  } finally {
    changingItemIds.value = changingItemIds.value.filter((id) => id !== item.id);
  }
}

function isChanging(item: OutstandingItem): boolean {
  return changingItemIds.value.includes(item.id);
}

watch([projectId, status, pageSize], () => {
  page.value = 1;
});
</script>

<template>
  <UiBox sticky-header data-testid="outstanding-items-box">
    <template #header>
      <UiBoxTitle :icon="ListChecks" title="未結項" :count="pageInfo.total" />
      <div class="outstanding-items__filters">
        <UiActionMenu
          v-model="projectId"
          label="專案"
          header="篩選專案"
          default-value=""
          align="end"
          :items="projectOptions"
        />
        <UiActionMenu
          v-model="status"
          label="狀態"
          header="篩選未結項狀態"
          default-value="pending"
          align="end"
          :items="statusOptions"
        />
      </div>
    </template>

    <UiFlash v-if="error" tone="danger" data-testid="outstanding-items-error">
      {{ error }}
      <template #actions><UiButton size="sm" @click="emit('retry')">重試</UiButton></template>
    </UiFlash>
    <UiSkeleton v-if="loading && !loaded" :count="4" data-testid="outstanding-items-loading" />
    <UiEmptyState
      v-else-if="loaded && !error && items.length === 0"
      :icon="ListChecks"
      :title="emptyTitle"
      description="完成的 Session 中回報的 nextSteps 會自動列在這裡；可以依專案篩選，並更新追蹤狀態。"
      data-testid="outstanding-items-empty"
    >
      <template #action>
        <UiButton v-if="hasFilters" @click="clearFilters">清除篩選</UiButton>
        <UiButton v-else @click="emit('showSessions')">返回工作歷程</UiButton>
      </template>
    </UiEmptyState>
    <VirtualList
      v-else-if="!error && items.length > 0"
      :items="items"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      label="未結項清單"
    >
      <template #default="{ item }">
        <UiBoxRow data-testid="outstanding-item">
          <template #title>{{ item.text }}</template>
          <template #meta>
            <span>{{ item.projectName }}</span>
            ·
            <!-- This action opens the source Session panel while preserving the current filters. -->
            <button
              type="button"
              class="outstanding-items__source"
              :aria-label="`開啟來源 Session：${item.sourceSessionTitle}`"
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
                    >標記完成</UiButton
                  >
                  <UiButton
                    size="sm"
                    :loading="isChanging(item)"
                    :disabled="isChanging(item)"
                    @click="updateItemStatus(item, 'not_needed')"
                    >不再需要</UiButton
                  >
                </template>
                <UiButton
                  v-else
                  size="sm"
                  :loading="isChanging(item)"
                  :disabled="isChanging(item)"
                  @click="updateItemStatus(item, 'pending')"
                  >重新開啟</UiButton
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
        size-label="未結項每頁筆數"
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

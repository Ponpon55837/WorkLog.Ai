<script setup lang="ts">
import { computed, watch } from "vue";
import { ListChecks, Search, X } from "lucide-vue-next";
import type { WorkSessionRecord } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import SessionRow from "../components/domain/SessionRow.vue";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiDateRangeMenu from "../components/ui/UiDateRangeMenu.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiGroupLabel from "../components/ui/UiGroupLabel.vue";
import UiPagination from "../components/ui/UiPagination.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import VirtualList from "../components/VirtualList.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { useListReload } from "../composables/useListReload";
import { useProjects } from "../composables/useProjects";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { useSessionDetail } from "../composables/useSessionDetail";
import { useSessions } from "../composables/useSessions";
import { formatDayGroup } from "../utils/format";
import { listPageSizeOptions } from "../utils/labels";

const { projects } = useProjects();
const {
  sessions,
  sessionsLoading,
  sessionsLoaded,
  searchTerm,
  selectedProjectId,
  sessionPage,
  sessionPageSize,
  sessionPageInfo,
  dateFrom,
  dateTo,
  sessionFilterError,
  hasSessionFilters,
  loadSessions,
  clearSessionFilters
} = useSessions();
const { openSessionDetail, setSessionSequence } = useSessionDetail();

useRouteQuery("q", searchTerm, stringQuery());
useRouteQuery("project", selectedProjectId, stringQuery());
useRouteQuery("from", dateFrom, stringQuery());
useRouteQuery("to", dateTo, stringQuery());
useRouteQuery("page", sessionPage, pageQuery());
useRouteQuery("size", sessionPageSize, enumQuery(listPageSizeOptions.map((option) => option.value), 10));
const { reloadNow } = useListReload({ load: loadSessions, page: sessionPage, filters: [selectedProjectId, dateFrom, dateTo, sessionPageSize], search: searchTerm });
useViewLoader(loadSessions);

const projectItems = computed(() => [
  { value: "", label: "所有專案" },
  ...projects.value.map((project) => ({ value: project.id, label: project.name }))
]);
const dateRange = computed({
  get: () => ({ from: dateFrom.value, to: dateTo.value }),
  set: (range) => {
    dateFrom.value = range.from;
    dateTo.value = range.to;
  }
});

function dayGroupAt(index: number): string | undefined {
  const current = sessions.value[index];
  if (!current) {
    return undefined;
  }
  const label = formatDayGroup(current.completedAt);
  const previous = sessions.value[index - 1];
  return !previous || formatDayGroup(previous.completedAt) !== label ? label : undefined;
}

function openSession(session: WorkSessionRecord): void {
  void openSessionDetail(session.id);
}

watch(sessions, (items) => setSessionSequence(items.map((item) => item.id)), { immediate: true });
</script>

<template>
  <PageHeader description="每一次完成，都留下可追溯的脈絡。" />

  <form class="sessions-search" role="search" @submit.prevent="reloadNow">
    <UiTextInput v-model="searchTerm" class="sessions-search__input" type="search" :icon="Search" label="搜尋工作歷程" placeholder="搜尋 title、summary 或 event" />
    <UiButton v-if="hasSessionFilters" :icon="X" @click="clearSessionFilters">清除篩選</UiButton>
  </form>

  <UiFlash v-if="sessionFilterError" tone="danger">{{ sessionFilterError }}</UiFlash>

  <UiBox>
    <template #header>
      <UiBoxTitle :icon="ListChecks" :title="`${sessionPageInfo.total} Sessions`">
        <span v-if="sessionPageInfo.total" class="sessions__range">顯示 {{ sessionPageInfo.from }}–{{ sessionPageInfo.to }}</span>
      </UiBoxTitle>
      <div class="sessions__filters">
        <UiActionMenu v-model="selectedProjectId" label="專案" header="篩選專案" default-value="" align="end" :items="projectItems" />
        <UiDateRangeMenu v-model="dateRange" />
      </div>
    </template>

    <UiSkeleton v-if="sessionsLoading && !sessionsLoaded" :count="5" />
    <UiEmptyState
      v-else-if="sessions.length === 0"
      :icon="ListChecks"
      :title="hasSessionFilters ? '沒有符合條件的 Session' : '還沒有工作紀錄'"
      :description="hasSessionFilters ? '調整搜尋或篩選條件後再試一次。' : '記錄中的專案完成 Session 後，會依時間出現在這裡。'"
    >
      <template v-if="hasSessionFilters" #action><UiButton @click="clearSessionFilters">清除篩選</UiButton></template>
    </UiEmptyState>
    <VirtualList v-else :items="sessions" :enabled="sessionPageSize === 'all'" label="工作歷程清單">
      <template #default="{ item, index }">
        <UiGroupLabel v-if="dayGroupAt(index)">{{ dayGroupAt(index) }}</UiGroupLabel>
        <SessionRow :session="item" @open="openSession" />
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination v-model:page-size="sessionPageSize" :page-info="sessionPageInfo" size-label="工作歷程每頁筆數" @page="sessionPage = $event" />
    </template>
  </UiBox>
</template>

<style scoped>
.sessions-search {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.sessions-search__input {
  flex: 1;
}

.sessions__range {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.sessions__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import { ListChecks, Search, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import type { OutstandingItemStatus, WorkSessionRecord } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import OutstandingItemsBox from "../components/domain/OutstandingItemsBox.vue";
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
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import VirtualList from "../components/VirtualList.vue";
import { useListReload } from "../composables/useListReload";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { router } from "../router";
import { useOutstandingItemsStore } from "../stores/outstanding-items";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { formatDayGroup } from "../utils/format";
import {
  listPageSizeOptions,
  outstandingItemStatusLabels,
  voidedFilterOptions,
  type ListPageSize,
} from "../utils/labels";

type SessionsTab = "sessions" | "outstanding";
const sessionTabs: readonly SessionsTab[] = ["sessions", "outstanding"];

const route = useRoute();
const projectsStore = useProjectsStore();
const { projects } = storeToRefs(projectsStore);
const sessionsStore = useSessionsStore();
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
  voidedFilter,
  sessionFilterError,
  hasSessionFilters,
} = storeToRefs(sessionsStore);
const { loadSessions, clearSessionFilters, setSessionsListActive } = sessionsStore;
const { openSessionDetail, setSessionSequence } = sessionsStore;
const outstandingItemsStore = useOutstandingItemsStore();
const {
  items: outstandingItems,
  projectId: outstandingProjectId,
  status: outstandingStatus,
  page: outstandingPage,
  pageSize: outstandingPageSize,
  from: outstandingFrom,
  to: outstandingTo,
  pageInfo: outstandingPageInfo,
  loading: outstandingLoading,
  loaded: outstandingLoaded,
  error: outstandingError,
} = storeToRefs(outstandingItemsStore);
const { reload: reloadOutstandingItems, setListActive: setOutstandingItemsListActive } = outstandingItemsStore;

useRouteQuery("q", searchTerm, stringQuery());
useRouteQuery("project", selectedProjectId, stringQuery());
useRouteQuery("from", dateFrom, stringQuery());
useRouteQuery("to", dateTo, stringQuery());
useRouteQuery(
  "voided",
  voidedFilter,
  enumQuery(
    voidedFilterOptions.map((option) => option.value),
    "exclude",
  ),
);
useRouteQuery("page", sessionPage, pageQuery());
useRouteQuery(
  "size",
  sessionPageSize,
  enumQuery(
    listPageSizeOptions.map((option) => option.value),
    10,
  ),
);
useRouteQuery("itemProject", outstandingProjectId, stringQuery());
useRouteQuery("itemFrom", outstandingFrom, stringQuery());
useRouteQuery("itemTo", outstandingTo, stringQuery());
useRouteQuery(
  "itemStatus",
  outstandingStatus,
  enumQuery<OutstandingItemStatus>(Object.keys(outstandingItemStatusLabels) as OutstandingItemStatus[], "pending"),
);
useRouteQuery("itemPage", outstandingPage, pageQuery());
useRouteQuery(
  "itemSize",
  outstandingPageSize,
  enumQuery<ListPageSize>(
    listPageSizeOptions.map((option) => option.value),
    10,
  ),
);

const { reloadNow } = useListReload({
  load: loadSessions,
  page: sessionPage,
  filters: [selectedProjectId, dateFrom, dateTo, voidedFilter, sessionPageSize],
  search: searchTerm,
});

useListReload({
  load: () => outstandingItemsStore.listEnabled && reloadOutstandingItems(),
  page: outstandingPage,
  filters: [outstandingProjectId, outstandingStatus, outstandingPageSize, outstandingFrom, outstandingTo],
});

const tab = computed<SessionsTab>({
  get: () => {
    const value = String(route.params.tab ?? "");
    return (sessionTabs as readonly string[]).includes(value) ? (value as SessionsTab) : "sessions";
  },
  set: (value) =>
    void router.replace({
      name: "sessions",
      params: { tab: value === "sessions" ? undefined : value },
      query: route.query,
    }),
});
const projectItems = computed(() => [
  { value: "", label: "所有專案" },
  ...projects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const tabs = computed(() => [
  { value: "sessions" as const, label: "工作歷程", icon: ListChecks, count: sessionPageInfo.value.total },
  { value: "outstanding" as const, label: "未結項", icon: ListChecks, count: outstandingPageInfo.value.total },
]);
const dateRange = computed({
  get: () => ({ from: dateFrom.value, to: dateTo.value }),
  set: (range) => {
    dateFrom.value = range.from;
    dateTo.value = range.to;
  },
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

watch(
  tab,
  (selectedTab) => {
    setSessionsListActive(selectedTab === "sessions");
    setOutstandingItemsListActive(selectedTab === "outstanding");
  },
  { immediate: true },
);
watch(sessions, (items) => setSessionSequence(items.map((item) => item.id)), { immediate: true });

onBeforeUnmount(() => {
  setSessionsListActive(false);
  setOutstandingItemsListActive(false);
});
</script>

<template>
  <PageHeader description="每一次完成，都留下可追溯的脈絡。" />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" label="工作歷程分頁" id-prefix="sessions" />
    <form v-if="tab === 'sessions'" class="sessions-search" role="search" @submit.prevent="reloadNow">
      <UiTextInput
        v-model="searchTerm"
        class="sessions-search__input"
        type="search"
        :icon="Search"
        label="搜尋工作歷程"
        placeholder="搜尋 title、summary 或 event"
      />
      <UiButton v-if="hasSessionFilters" :icon="X" @click="clearSessionFilters">清除篩選</UiButton>
    </form>
  </PageToolbar>

  <UiFlash v-if="sessionFilterError && tab === 'sessions'" tone="danger">{{ sessionFilterError }}</UiFlash>

  <section
    v-if="tab === 'sessions'"
    id="sessions-panel-sessions"
    role="tabpanel"
    aria-labelledby="sessions-tab-sessions"
  >
    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle :icon="ListChecks" :title="`${sessionPageInfo.total} Sessions`">
          <span v-if="sessionPageInfo.total" class="sessions__range"
            >顯示 {{ sessionPageInfo.from }}–{{ sessionPageInfo.to }}</span
          >
        </UiBoxTitle>
        <div class="sessions__filters">
          <UiActionMenu
            v-model="selectedProjectId"
            label="專案"
            header="篩選專案"
            default-value=""
            align="end"
            :items="projectItems"
          />
          <UiDateRangeMenu v-model="dateRange" />
          <UiActionMenu
            v-model="voidedFilter"
            label="作廢"
            header="已作廢的 Session"
            default-value="exclude"
            align="end"
            :items="voidedFilterOptions"
          />
        </div>
      </template>

      <UiSkeleton v-if="sessionsLoading && !sessionsLoaded" :count="5" />
      <UiEmptyState
        v-else-if="sessions.length === 0"
        :icon="ListChecks"
        :title="hasSessionFilters ? '沒有符合條件的 Session' : '還沒有工作紀錄'"
        :description="
          hasSessionFilters ? '調整搜尋或篩選條件後再試一次。' : '記錄中的專案完成 Session 後，會依時間出現在這裡。'
        "
      >
        <template v-if="hasSessionFilters" #action><UiButton @click="clearSessionFilters">清除篩選</UiButton></template>
      </UiEmptyState>
      <VirtualList
        v-else
        :items="sessions"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        label="工作歷程清單"
      >
        <template #default="{ item, index }">
          <UiGroupLabel v-if="dayGroupAt(index)">{{ dayGroupAt(index) }}</UiGroupLabel>
          <SessionRow :session="item" @open="openSession" />
        </template>
      </VirtualList>

      <template #footer>
        <UiPagination
          v-model:page-size="sessionPageSize"
          :page-info="sessionPageInfo"
          size-label="工作歷程每頁筆數"
          @page="sessionPage = $event"
        />
      </template>
    </UiBox>
  </section>
  <section v-else id="sessions-panel-outstanding" role="tabpanel" aria-labelledby="sessions-tab-outstanding">
    <OutstandingItemsBox
      v-model:project-id="outstandingProjectId"
      v-model:status="outstandingStatus"
      v-model:page="outstandingPage"
      v-model:page-size="outstandingPageSize"
      v-model:from="outstandingFrom"
      v-model:to="outstandingTo"
      :items="outstandingItems"
      :projects="projects"
      :page-info="outstandingPageInfo"
      :loading="outstandingLoading"
      :loaded="outstandingLoaded"
      :error="outstandingError"
      @retry="reloadOutstandingItems"
      @open-session="openSessionDetail"
      @show-sessions="tab = 'sessions'"
    />
  </section>
</template>

<style scoped>
.sessions-search {
  display: flex;
  flex: 1;
  gap: var(--space-2);
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

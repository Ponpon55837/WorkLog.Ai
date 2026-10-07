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
import { t } from "../i18n";

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
  selectedAgent,
  agentOptions,
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
useRouteQuery("agent", selectedAgent, stringQuery());
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
  filters: [selectedProjectId, selectedAgent, dateFrom, dateTo, voidedFilter, sessionPageSize],
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
  { value: "", label: t("common.allProjects") },
  ...projects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const agentItems = computed(() => [
  { value: "", label: t("common.allAgents") },
  ...agentOptions.value.map((agent) => ({ value: agent, label: agent })),
]);
const tabs = computed(() => [
  // Counts appear once loaded; "0" before then would read as "nothing here".
  {
    value: "sessions" as const,
    label: t("common.workHistory"),
    icon: ListChecks,
    count: sessionsLoaded.value ? sessionPageInfo.value.total : undefined,
  },
  {
    value: "outstanding" as const,
    label: t("common.openItems"),
    icon: ListChecks,
    count: outstandingLoaded.value ? outstandingPageInfo.value.total : undefined,
  },
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
  <PageHeader :description="t('sessions.everyFinishedTaskLeavesTraceable')" />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" :label="t('sessions.workHistoryTabs')" id-prefix="sessions" />
    <form v-if="tab === 'sessions'" class="sessions-search" role="search" @submit.prevent="reloadNow">
      <UiTextInput
        v-model="searchTerm"
        class="sessions-search__input"
        type="search"
        :icon="Search"
        :label="t('sessions.searchWorkHistory')"
        :placeholder="t('common.searchTitleSummaryOrEvent')"
      />
      <UiButton v-if="hasSessionFilters" :icon="X" @click="clearSessionFilters">{{
        t("common.clearFilters")
      }}</UiButton>
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
        <UiBoxTitle :icon="ListChecks" :title="sessionsLoaded ? `${sessionPageInfo.total} Sessions` : 'Sessions'">
          <span v-if="sessionPageInfo.total" class="sessions__range">{{
            t("sessions.showing", { from: sessionPageInfo.from, to: sessionPageInfo.to })
          }}</span>
        </UiBoxTitle>
        <div class="sessions__filters">
          <UiActionMenu
            v-model="selectedProjectId"
            :label="t('common.project')"
            :header="t('common.filterProject')"
            default-value=""
            align="end"
            :items="projectItems"
          />
          <UiActionMenu
            v-if="agentOptions.length > 0"
            v-model="selectedAgent"
            :label="t('common.agent')"
            :header="t('common.filterAgent')"
            default-value=""
            align="end"
            :items="agentItems"
          />
          <UiDateRangeMenu v-model="dateRange" />
          <UiActionMenu
            v-model="voidedFilter"
            :label="t('common.void')"
            :header="t('sessions.voidedSessions')"
            default-value="exclude"
            align="end"
            :items="voidedFilterOptions"
          />
        </div>
      </template>

      <UiSkeleton v-if="sessionsLoading && !sessionsLoaded" :count="5" :label="t('sessions.loadingWorkHistory')" />
      <UiEmptyState
        v-else-if="sessions.length === 0"
        :icon="ListChecks"
        :title="hasSessionFilters ? t('sessions.noSessionsMatchTheFilters') : t('common.noWorkRecordsYet')"
        :description="
          hasSessionFilters ? t('common.adjustTheSearchOrFilters') : t('sessions.sessionsCompletedInTrackedProjects')
        "
      >
        <template v-if="hasSessionFilters" #action
          ><UiButton @click="clearSessionFilters">{{ t("common.clearFilters") }}</UiButton></template
        >
      </UiEmptyState>
      <VirtualList
        v-else
        :items="sessions"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        :label="t('sessions.workHistoryList')"
      >
        <template #default="{ item, index }">
          <UiGroupLabel v-if="dayGroupAt(index)">{{ dayGroupAt(index) }}</UiGroupLabel>
          <SessionRow :session="item" @open="openSession" />
        </template>
      </VirtualList>

      <template v-if="sessionsLoaded" #footer>
        <UiPagination
          v-model:page-size="sessionPageSize"
          :page-info="sessionPageInfo"
          :size-label="t('sessions.workHistoryPerPage')"
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

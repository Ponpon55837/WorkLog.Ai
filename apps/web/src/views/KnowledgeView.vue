<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import { BookMarked, BookOpen, ListChecks, Search, Sparkles, X } from "lucide-vue-next";
import {
  KNOWLEDGE_CONVENTION_LIMIT,
  type KnowledgeKind,
  type KnowledgeRecord,
  type KnowledgeStatus,
} from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import AgentKnowledgeReviewBox from "../components/domain/AgentKnowledgeReviewBox.vue";
import AgentReviewFilter from "../components/domain/AgentReviewFilter.vue";
import AgentReviewRequestBox from "../components/domain/AgentReviewRequestBox.vue";
import KnowledgeCandidateEditorDialog from "../components/domain/KnowledgeCandidateEditorDialog.vue";
import KnowledgeCandidatesBox from "../components/domain/KnowledgeCandidatesBox.vue";
import AgentDecisionReviewBox from "../components/domain/AgentDecisionReviewBox.vue";
import ProjectFilterMenu from "../components/domain/ProjectFilterMenu.vue";
import KnowledgePagePanel from "../components/domain/KnowledgePagePanel.vue";
import KnowledgePagesBox from "../components/domain/KnowledgePagesBox.vue";
import KnowledgeKindOverview from "../components/domain/KnowledgeKindOverview.vue";
import KnowledgeRow, { type KnowledgeAction } from "../components/domain/KnowledgeRow.vue";
import type { FilterChip } from "../components/ui/types";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFilterChips from "../components/ui/UiFilterChips.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiPagination from "../components/ui/UiPagination.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiSplitLayout from "../components/ui/UiSplitLayout.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import VirtualList from "../components/VirtualList.vue";
import { useProjectChip } from "../composables/useProjectChip";
import { useKnowledgeActions } from "../composables/useKnowledge";
import { useListReload } from "../composables/useListReload";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { router } from "../router";
import { useAgentReviewStore } from "../stores/agent-review";
import { useKnowledgeEditorStore } from "../stores/knowledge-editor";
import { useProjectsStore } from "../stores/projects";
import { useToast } from "../composables/useToast";
import { useKnowledgeStore } from "../stores/knowledge";
import { useKnowledgeKindCountsStore } from "../stores/knowledge-kind-counts";
import { useKnowledgePagesStore } from "../stores/knowledge-pages";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { knowledgeKindLabels, knowledgeStatusLabels, listPageSizeOptions } from "../utils/labels";
import { knowledgeKindVisual } from "../utils/status";
import { filterChip } from "../utils/filter-chips";
import { t } from "../i18n";

type KnowledgeTab = "list" | "pages" | "candidates" | "decisions";
const knowledgeTabs: readonly KnowledgeTab[] = ["decisions", "candidates", "list", "pages"];

const knowledgeStore = useKnowledgeStore();
const {
  knowledgeItems,
  knowledgePage,
  knowledgePageSize,
  knowledgePageInfo,
  knowledgeQuery,
  knowledgeKind,
  knowledgeProjectId,
  knowledgeStatus,
  knowledgeConvention,
  conventionCounts,
  knowledgeBaselineTotal,
  knowledgeLoading,
  knowledgeError,
  knowledgeSkippedRecords,
} = storeToRefs(knowledgeStore);
const { loadKnowledge, retryKnowledge, setKnowledgeListActive, setConventionsActive } = knowledgeStore;
const kindCountsStore = useKnowledgeKindCountsStore();
const { counts: kindCounts, loading: kindCountsLoading } = storeToRefs(kindCountsStore);
const {
  setKnowledgeStatus,
  openKnowledgeSession,
  openKnowledgeStaleSession,
  confirmKnowledge,
  setKnowledgeConvention,
  openKnowledgeEditor,
  openKnowledgeHistory,
} = useKnowledgeActions();

const kinds = Object.keys(knowledgeKindLabels) as KnowledgeKind[];
useRouteQuery("q", knowledgeQuery, stringQuery());
useRouteQuery("kind", knowledgeKind, enumQuery<KnowledgeKind | "">(["", ...kinds], ""));
useRouteQuery("project", knowledgeProjectId, stringQuery());
useRouteQuery("status", knowledgeStatus, enumQuery<KnowledgeStatus>(["active", "archived"], "active"));
useRouteQuery("convention", knowledgeConvention, enumQuery<"" | "only">(["", "only"], ""));
useRouteQuery("page", knowledgePage, pageQuery());
useRouteQuery(
  "size",
  knowledgePageSize,
  enumQuery(
    listPageSizeOptions.map((option) => option.value),
    10,
  ),
);
const { reloadNow } = useListReload({
  load: loadKnowledge,
  page: knowledgePage,
  filters: [knowledgeKind, knowledgeProjectId, knowledgeStatus, knowledgeConvention, knowledgePageSize],
  search: knowledgeQuery,
});
const route = useRoute();

// The page owns the candidate and decision queries so every tab can show its count, not only the open one.
const agentReviewStore = useAgentReviewStore();
const { filter: reviewFilter } = storeToRefs(agentReviewStore);
useRouteQuery("review", reviewFilter, enumQuery(["pending", "agent"] as const, "pending"));
const decisionStore = useSessionDecisionsStore();
const { pendingCount, decisionsLoaded } = storeToRefs(decisionStore);
const { candidates, candidatesLoaded, knowledgeLoaded } = storeToRefs(knowledgeStore);
const editorStore = useKnowledgeEditorStore();
const projectsStore = useProjectsStore();
const { trackedProjects } = storeToRefs(projectsStore);
const pagesStore = useKnowledgePagesStore();
const { pages, pagesLoaded, openPageId } = storeToRefs(pagesStore);
useRouteQuery("knowledgePage", openPageId, {
  defaultValue: null,
  parse: (raw) => raw || null,
  serialize: (value) => value ?? "",
});
const projectChip = useProjectChip(knowledgeProjectId);

const entryTab = ref<KnowledgeTab | null>(null);
const selectedKnowledgeId = ref("");
const targetedDecisionId = ref("");
const openedKnowledgeId = ref("");

useRouteQuery("knowledge", selectedKnowledgeId, stringQuery());
useRouteQuery("decision", targetedDecisionId, stringQuery());

const hasFilters = computed(() =>
  Boolean(
    knowledgeQuery.value ||
    knowledgeKind.value ||
    knowledgeProjectId.value ||
    knowledgeConvention.value ||
    knowledgeStatus.value !== "active",
  ),
);
const conventionItems = computed(() => {
  const count = knowledgeProjectId.value ? (conventionCounts.value[knowledgeProjectId.value] ?? 0) : undefined;
  return [
    { value: "" as const, label: t("knowledge.conventionFilterAll") },
    {
      value: "only" as const,
      label:
        count === undefined
          ? t("knowledge.convention")
          : t("knowledge.conventionWithCounter", { count, limit: KNOWLEDGE_CONVENTION_LIMIT }),
    },
  ];
});
const knowledgeFilterChips = computed(() => {
  const chips: FilterChip[] = [];
  if (projectChip.value) chips.push(projectChip.value);
  if (knowledgeKind.value) {
    chips.push(filterChip("kind", t("common.kind"), knowledgeKindLabels[knowledgeKind.value]));
  }
  if (knowledgeConvention.value) {
    chips.push({ key: "convention", label: t("knowledge.convention") });
  }
  if (knowledgeStatus.value !== "active") {
    chips.push(filterChip("status", t("common.status"), knowledgeStatusLabels[knowledgeStatus.value]));
  }
  return chips;
});
const isAgentView = computed(() => reviewFilter.value === "agent");
const selectedProjectRoot = computed(
  () => trackedProjects.value.find((project) => project.id === knowledgeProjectId.value)?.rootPath,
);
const routeTab = computed(() => {
  const value = String(route.params.tab ?? "");
  return (knowledgeTabs as readonly string[]).includes(value) ? (value as KnowledgeTab) : null;
});
const tab = computed<KnowledgeTab>({
  get: () => routeTab.value ?? entryTab.value ?? "decisions",
  set: (value) => void router.replace({ name: "knowledge", params: { tab: value }, query: route.query }),
});

const knowledgeTabCount = computed(() =>
  knowledgeBaselineTotal.value === undefined || knowledgeBaselineTotal.value === knowledgePageInfo.value.total
    ? knowledgePageInfo.value.total
    : t("common.filteredCount", { shown: knowledgePageInfo.value.total, total: knowledgeBaselineTotal.value }),
);

// A tab shows its count only once that count has loaded; "0" before then would read as "nothing here".
const tabs = computed(() => [
  {
    value: "decisions" as const,
    label: t("knowledge.decisionsToConfirm"),
    icon: ListChecks,
    count: decisionsLoaded.value ? pendingCount.value : undefined,
  },
  {
    value: "candidates" as const,
    label: t("knowledge.candidates"),
    icon: Sparkles,
    count: candidatesLoaded.value ? candidates.value.length : undefined,
  },
  {
    value: "list" as const,
    label: "Knowledge",
    icon: BookOpen,
    count: knowledgeLoaded.value ? knowledgeTabCount.value : undefined,
  },
  {
    value: "pages" as const,
    label: t("common.knowledgePages"),
    icon: BookMarked,
    count: pagesLoaded.value ? pages.value.length : undefined,
  },
]);
const kindItems = [
  { value: "" as const, label: t("common.allKinds") },
  ...kinds.map((kind) => ({
    value: kind,
    label: knowledgeKindLabels[kind],
    icon: knowledgeKindVisual[kind].icon,
    tone: knowledgeKindVisual[kind].tone,
  })),
];
const statusItems = (Object.keys(knowledgeStatusLabels) as KnowledgeStatus[]).map((status) => ({
  value: status,
  label: knowledgeStatusLabels[status],
}));

async function openSelectedKnowledge(): Promise<void> {
  const id = selectedKnowledgeId.value;
  const projectId = knowledgeProjectId.value;
  if (!id) return;
  const project = projectsStore.projects.find((item) => item.id === projectId && item.status === "tracked");
  if (!project) return;
  const item = await knowledgeStore.loadKnowledgeHistory(id, project.rootPath);
  if (selectedKnowledgeId.value !== id || knowledgeProjectId.value !== projectId) return;
  if (item && item.id === id && item.projectId === projectId) {
    openedKnowledgeId.value = id;
    editorStore.knowledgeHistoryItem = item;
  } else {
    useToast().showToast(knowledgeStore.knowledgeHistoryError || t("knowledge.knowledgeGone"), "danger");
  }
}

function removeKnowledgeFilter(key: string): void {
  if (key === "project") knowledgeProjectId.value = "";
  else if (key === "kind") knowledgeKind.value = "";
  else if (key === "convention") knowledgeConvention.value = "";
  else knowledgeStatus.value = "active";
}

function clearFilters(): void {
  knowledgeQuery.value = "";
  knowledgeKind.value = "";
  knowledgeProjectId.value = "";
  knowledgeConvention.value = "";
  knowledgeStatus.value = "active";
}

function onAction(action: KnowledgeAction, item: KnowledgeRecord): void {
  if (action === "confirm") {
    void confirmKnowledge(item);
  } else if (action === "stale-source") {
    void openKnowledgeStaleSession(item);
  } else if (action === "edit") {
    openKnowledgeEditor(item);
  } else if (action === "convention") {
    void setKnowledgeConvention(item, !item.conventionConfirmedAt);
  } else if (action === "history") {
    void openKnowledgeHistory(item);
  } else if (action === "source") {
    void openKnowledgeSession(item);
  } else {
    void setKnowledgeStatus(item, item.status === "active" ? "archived" : "active");
  }
}

// A bare /knowledge opens the decisions tab while something waits for review, once the counts are known.
watch(
  [routeTab, decisionsLoaded],
  ([chosen, loaded]) => {
    if (chosen) entryTab.value = null;
    else if (loaded && entryTab.value === null) entryTab.value = pendingCount.value > 0 ? "decisions" : "list";
  },
  { immediate: true },
);
watch(
  [tab, knowledgeProjectId, knowledgeStatus],
  () => {
    kindCountsStore.scope =
      tab.value === "list" ? { projectId: knowledgeProjectId.value, status: knowledgeStatus.value } : null;
  },
  { immediate: true },
);
watch([selectedKnowledgeId, knowledgeProjectId, () => projectsStore.projects], () => void openSelectedKnowledge(), {
  immediate: true,
});
watch(
  () => editorStore.knowledgeHistoryItem,
  (item) => {
    if (!item && openedKnowledgeId.value === selectedKnowledgeId.value) {
      selectedKnowledgeId.value = "";
      openedKnowledgeId.value = "";
    }
  },
);

watch([tab, isAgentView], ([value, agentView]) => agentReviewStore.setKnowledgeActive(value === "list" && agentView), {
  immediate: true,
});

watch(
  () => selectedProjectRoot.value,
  (root) => {
    decisionStore.setListActive(true, root);
    agentReviewStore.setScope(root ? knowledgeProjectId.value : "", root);
    agentReviewStore.setActive(true);
    pagesStore.setListActive(true, root);
    void knowledgeStore.loadCandidates(root);
  },
  { immediate: true },
);

onMounted(() => {
  setKnowledgeListActive(true);
  setConventionsActive(true);
});
onBeforeUnmount(() => {
  kindCountsStore.scope = null;
  setKnowledgeListActive(false);
  setConventionsActive(false);
  editorStore.knowledgeHistoryItem = null;
  knowledgeStore.closeKnowledgeHistory();
});
onBeforeUnmount(() => {
  decisionStore.setListActive(false);
  agentReviewStore.setActive(false);
  agentReviewStore.setKnowledgeActive(false);
});
onBeforeUnmount(() => {
  pagesStore.setListActive(false);
  pagesStore.closePage();
});
</script>

<template>
  <PageHeader :description="t('knowledge.knowledgeOnlyAcceptsConfirmedContent')" />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" :label="t('knowledge.workKnowledgeTabs')" id-prefix="knowledge" />
    <form v-if="tab === 'list' && !isAgentView" class="knowledge-search" role="search" @submit.prevent="reloadNow">
      <UiTextInput
        v-model="knowledgeQuery"
        class="knowledge-search__input"
        type="search"
        :icon="Search"
        :label="t('knowledge.searchKnowledge')"
        :placeholder="t('knowledge.searchTitleBodyTagsOr')"
      />
      <UiButton v-if="hasFilters" :icon="X" @click="clearFilters">{{ t("common.clearFilters") }}</UiButton>
    </form>
  </PageToolbar>

  <UiFlash v-if="knowledgeError && tab === 'list'" tone="danger">
    {{ knowledgeError }}
    <template #actions
      ><UiButton size="sm" @click="retryKnowledge">{{ t("common.retry") }}</UiButton></template
    >
  </UiFlash>
  <UiFlash
    v-else-if="knowledgeSkippedRecords > 0 && tab === 'list'"
    tone="attention"
    data-testid="knowledge-search-incomplete"
  >
    {{ t("common.searchSkippedRecords", { count: knowledgeSkippedRecords }) }}
  </UiFlash>

  <KnowledgeCandidateEditorDialog :project-root="selectedProjectRoot" />
  <KnowledgePagePanel :projects="trackedProjects" />

  <UiSplitLayout
    v-if="tab === 'decisions'"
    id="knowledge-panel-decisions"
    role="tabpanel"
    aria-labelledby="knowledge-tab-decisions"
  >
    <template #main
      ><AgentDecisionReviewBox :project-root="selectedProjectRoot" :highlight-id="targetedDecisionId"
    /></template>
    <template #aside>
      <AgentReviewRequestBox v-model:project-id="knowledgeProjectId" :projects="trackedProjects" />
    </template>
  </UiSplitLayout>
  <section v-else-if="tab === 'pages'" id="knowledge-panel-pages" role="tabpanel" aria-labelledby="knowledge-tab-pages">
    <KnowledgePagesBox v-model:project-id="knowledgeProjectId" :projects="trackedProjects" />
  </section>
  <UiSplitLayout
    v-else-if="tab === 'candidates'"
    id="knowledge-panel-candidates"
    role="tabpanel"
    aria-labelledby="knowledge-tab-candidates"
  >
    <template #main>
      <KnowledgeCandidatesBox :projects="trackedProjects" :project-root="selectedProjectRoot" />
    </template>
    <template #aside>
      <AgentReviewRequestBox v-model:project-id="knowledgeProjectId" :projects="trackedProjects" />
    </template>
  </UiSplitLayout>
  <UiSplitLayout v-else>
    <template #main>
      <AgentKnowledgeReviewBox
        v-if="isAgentView"
        id="knowledge-panel-list"
        role="tabpanel"
        aria-labelledby="knowledge-tab-list"
        :projects="trackedProjects"
        :project-root="selectedProjectRoot"
      />
      <UiBox v-else id="knowledge-panel-list" role="tabpanel" aria-labelledby="knowledge-tab-list" sticky-header>
        <template #header>
          <UiBoxTitle
            :icon="BookOpen"
            :title="
              knowledgeStatus === 'active'
                ? t('knowledge.activeKnowledge', { total: knowledgePageInfo.total })
                : t('knowledge.archivedKnowledge', { total: knowledgePageInfo.total })
            "
          />
          <div class="knowledge__filters">
            <AgentReviewFilter v-model="reviewFilter" :pending-label="t('knowledge.reviewFilterAllKnowledge')" />
            <ProjectFilterMenu v-model="knowledgeProjectId" :header="t('common.filterProject')" align="end" />
            <UiActionMenu
              v-model="knowledgeKind"
              :label="t('common.kind')"
              :header="t('knowledge.filterKind')"
              default-value=""
              align="end"
              :items="kindItems"
            />
            <UiActionMenu
              v-model="knowledgeConvention"
              :label="t('knowledge.convention')"
              :header="t('knowledge.convention')"
              default-value=""
              align="end"
              :items="conventionItems"
            />
            <UiActionMenu
              v-model="knowledgeStatus"
              :label="t('common.status')"
              :header="t('knowledge.filterStatus')"
              default-value="active"
              align="end"
              :items="statusItems"
            />
          </div>
        </template>

        <UiFilterChips :chips="knowledgeFilterChips" @remove="removeKnowledgeFilter" />
        <UiSkeleton
          v-if="knowledgeLoading && knowledgeItems.length === 0"
          :count="4"
          :label="t('knowledge.loadingKnowledge')"
        />
        <UiEmptyState
          v-else-if="knowledgeLoaded && knowledgeItems.length === 0"
          :icon="BookOpen"
          :title="hasFilters ? t('knowledge.noKnowledgeMatchesTheFilters') : t('knowledge.noConfirmedKnowledgeYet')"
          :description="hasFilters ? t('common.adjustTheSearchOrFilters') : t('knowledge.itemsAppearHereOnceThe')"
        >
          <template v-if="hasFilters" #action
            ><UiButton @click="clearFilters">{{ t("common.clearFilters") }}</UiButton></template
          >
        </UiEmptyState>
        <VirtualList
          v-else-if="knowledgeItems.length > 0"
          :items="knowledgeItems"
          :enabled="true"
          fit-viewport
          fit-viewport-to-panel
          fill-available-space
          :estimate-item-height="140"
          :label="t('knowledge.workKnowledgeList')"
        >
          <template #default="{ item }">
            <KnowledgeRow
              :item="item"
              :convention-count="conventionCounts[item.projectId] ?? 0"
              :convention-full="(conventionCounts[item.projectId] ?? 0) >= KNOWLEDGE_CONVENTION_LIMIT"
              @action="onAction"
            />
          </template>
        </VirtualList>

        <template v-if="knowledgeLoaded" #footer>
          <UiPagination
            v-model:page-size="knowledgePageSize"
            :page-info="knowledgePageInfo"
            :size-label="t('knowledge.knowledgePerPage')"
            @page="knowledgePage = $event"
          />
        </template>
      </UiBox>
    </template>
    <template #aside>
      <AgentReviewRequestBox v-model:project-id="knowledgeProjectId" :projects="trackedProjects" />
      <!-- The card is held by a Skeleton while the counts load; a failed or skipped request leaves it out. -->
      <KnowledgeKindOverview
        v-if="kindCounts || kindCountsLoading"
        :counts="kindCounts ?? undefined"
        :status="knowledgeStatus"
        :search-active="Boolean(knowledgeQuery)"
        :kind-active="Boolean(knowledgeKind)"
      />
    </template>
  </UiSplitLayout>
</template>

<style scoped>
.knowledge-search {
  display: flex;
  flex: 1 1 100%;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.knowledge-search__input {
  flex: 1 1 200px;
  min-width: 0;
}

.knowledge__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>

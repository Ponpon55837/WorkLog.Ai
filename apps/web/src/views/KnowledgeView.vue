<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import { BookMarked, BookOpen, ListChecks, Search, Sparkles, X } from "lucide-vue-next";
import type { KnowledgeKind, KnowledgeRecord, KnowledgeStatus } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import KnowledgeCandidateEditorDialog from "../components/domain/KnowledgeCandidateEditorDialog.vue";
import KnowledgeCandidatesBox from "../components/domain/KnowledgeCandidatesBox.vue";
import AgentDecisionReviewBox from "../components/domain/AgentDecisionReviewBox.vue";
import KnowledgePagePanel from "../components/domain/KnowledgePagePanel.vue";
import KnowledgePagesBox from "../components/domain/KnowledgePagesBox.vue";
import KnowledgeRow, { type KnowledgeAction } from "../components/domain/KnowledgeRow.vue";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiPagination from "../components/ui/UiPagination.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import VirtualList from "../components/VirtualList.vue";
import { useKnowledgeActions } from "../composables/useKnowledge";
import { useListReload } from "../composables/useListReload";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { router } from "../router";
import { useKnowledgeEditorStore } from "../stores/knowledge-editor";
import { useProjectsStore } from "../stores/projects";
import { useToast } from "../composables/useToast";
import { useKnowledgeStore } from "../stores/knowledge";
import { useKnowledgePagesStore } from "../stores/knowledge-pages";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { knowledgeKindLabels, knowledgeStatusLabels, listPageSizeOptions } from "../utils/labels";
import { knowledgeKindVisual } from "../utils/status";
import { t } from "../i18n";

type KnowledgeTab = "list" | "pages" | "candidates" | "decisions";
const knowledgeTabs: readonly KnowledgeTab[] = ["list", "pages", "candidates", "decisions"];

const knowledgeStore = useKnowledgeStore();
const {
  knowledgeItems,
  knowledgeProjects,
  knowledgePage,
  knowledgePageSize,
  knowledgePageInfo,
  knowledgeQuery,
  knowledgeKind,
  knowledgeProjectId,
  knowledgeStatus,
  knowledgeLoading,
  knowledgeError,
} = storeToRefs(knowledgeStore);
const { loadKnowledge, retryKnowledge, setKnowledgeListActive } = knowledgeStore;
const {
  setKnowledgeStatus,
  openKnowledgeSession,
  openKnowledgeStaleSession,
  confirmKnowledge,
  openKnowledgeEditor,
  openKnowledgeHistory,
} = useKnowledgeActions();

const kinds = Object.keys(knowledgeKindLabels) as KnowledgeKind[];
useRouteQuery("q", knowledgeQuery, stringQuery());
useRouteQuery("kind", knowledgeKind, enumQuery<KnowledgeKind | "">(["", ...kinds], ""));
useRouteQuery("project", knowledgeProjectId, stringQuery());
useRouteQuery("status", knowledgeStatus, enumQuery<KnowledgeStatus>(["active", "archived"], "active"));
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
  filters: [knowledgeKind, knowledgeProjectId, knowledgeStatus, knowledgePageSize],
  search: knowledgeQuery,
});
const route = useRoute();

// The page owns the candidate and decision queries so every tab can show its count, not only the open one.
const decisionStore = useSessionDecisionsStore();
const { pendingCount, decisionsLoaded } = storeToRefs(decisionStore);
const { candidates, candidatesLoaded, knowledgeLoaded } = storeToRefs(knowledgeStore);
const editorStore = useKnowledgeEditorStore();
const projectsStore = useProjectsStore();
const pagesStore = useKnowledgePagesStore();
const { pages, pagesLoaded, openPageId } = storeToRefs(pagesStore);
useRouteQuery("knowledgePage", openPageId, {
  defaultValue: null,
  parse: (raw) => raw || null,
  serialize: (value) => value ?? "",
});

const selectedKnowledgeId = ref("");
const openedKnowledgeId = ref("");

useRouteQuery("knowledge", selectedKnowledgeId, stringQuery());

const hasFilters = computed(() =>
  Boolean(
    knowledgeQuery.value || knowledgeKind.value || knowledgeProjectId.value || knowledgeStatus.value !== "active",
  ),
);
const selectedProjectRoot = computed(
  () => knowledgeProjects.value.find((project) => project.id === knowledgeProjectId.value)?.rootPath,
);
const tab = computed<KnowledgeTab>({
  get: () => {
    const value = String(route.params.tab ?? "");
    return (knowledgeTabs as readonly string[]).includes(value) ? (value as KnowledgeTab) : "list";
  },
  // List filters live in the query string; keep them when switching tabs.
  set: (value) =>
    void router.replace({
      name: "knowledge",
      params: { tab: value === "list" ? undefined : value },
      query: route.query,
    }),
});

// A tab shows its count only once that count has loaded; "0" before then would read as "nothing here".
const tabs = computed(() => [
  {
    value: "list" as const,
    label: "Knowledge",
    icon: BookOpen,
    count: knowledgeLoaded.value ? knowledgePageInfo.value.total : undefined,
  },
  {
    value: "pages" as const,
    label: t("common.knowledgePages"),
    icon: BookMarked,
    count: pagesLoaded.value ? pages.value.length : undefined,
  },
  {
    value: "candidates" as const,
    label: t("knowledge.candidates"),
    icon: Sparkles,
    count: candidatesLoaded.value ? candidates.value.length : undefined,
  },
  {
    value: "decisions" as const,
    label: t("knowledge.decisionsToConfirm"),
    icon: ListChecks,
    count: decisionsLoaded.value ? pendingCount.value : undefined,
  },
]);
const projectItems = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...knowledgeProjects.value.map((project) => ({ value: project.id, label: project.name })),
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

function clearFilters(): void {
  knowledgeQuery.value = "";
  knowledgeKind.value = "";
  knowledgeProjectId.value = "";
  knowledgeStatus.value = "active";
}

function onAction(action: KnowledgeAction, item: KnowledgeRecord): void {
  if (action === "confirm") {
    void confirmKnowledge(item);
  } else if (action === "stale-source") {
    void openKnowledgeStaleSession(item);
  } else if (action === "edit") {
    openKnowledgeEditor(item);
  } else if (action === "history") {
    void openKnowledgeHistory(item);
  } else if (action === "source") {
    void openKnowledgeSession(item);
  } else {
    void setKnowledgeStatus(item, item.status === "active" ? "archived" : "active");
  }
}

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

watch(
  () => selectedProjectRoot.value,
  (root) => {
    decisionStore.setListActive(true, root);
    pagesStore.setListActive(true, root);
    void knowledgeStore.loadCandidates(root);
  },
  { immediate: true },
);

onMounted(() => setKnowledgeListActive(true));
onBeforeUnmount(() => {
  setKnowledgeListActive(false);
  editorStore.knowledgeHistoryItem = null;
  knowledgeStore.closeKnowledgeHistory();
});
onBeforeUnmount(() => decisionStore.setListActive(false));
onBeforeUnmount(() => {
  pagesStore.setListActive(false);
  pagesStore.closePage();
});
</script>

<template>
  <PageHeader :description="t('knowledge.knowledgeOnlyAcceptsConfirmedContent')" />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" :label="t('knowledge.workKnowledgeTabs')" id-prefix="knowledge" />
    <form v-if="tab === 'list'" class="knowledge-search" role="search" @submit.prevent="reloadNow">
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

  <KnowledgeCandidateEditorDialog :project-root="selectedProjectRoot" />
  <KnowledgePagePanel :projects="knowledgeProjects" />

  <section
    v-if="tab === 'decisions'"
    id="knowledge-panel-decisions"
    role="tabpanel"
    aria-labelledby="knowledge-tab-decisions"
  >
    <AgentDecisionReviewBox :project-root="selectedProjectRoot" />
  </section>
  <section v-else-if="tab === 'pages'" id="knowledge-panel-pages" role="tabpanel" aria-labelledby="knowledge-tab-pages">
    <KnowledgePagesBox v-model:project-id="knowledgeProjectId" :projects="knowledgeProjects" />
  </section>
  <section
    v-else-if="tab === 'candidates'"
    id="knowledge-panel-candidates"
    role="tabpanel"
    aria-labelledby="knowledge-tab-candidates"
  >
    <KnowledgeCandidatesBox :projects="knowledgeProjects" :project-root="selectedProjectRoot" />
  </section>
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
        <UiActionMenu
          v-model="knowledgeProjectId"
          :label="t('common.project')"
          :header="t('common.filterProject')"
          default-value=""
          align="end"
          :items="projectItems"
        />
        <UiActionMenu
          v-model="knowledgeKind"
          :label="t('common.kind')"
          :header="t('knowledge.filterKind')"
          default-value=""
          align="end"
          :items="kindItems"
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

    <UiSkeleton
      v-if="knowledgeLoading && knowledgeItems.length === 0"
      :count="4"
      :label="t('knowledge.loadingKnowledge')"
    />
    <UiEmptyState
      v-else-if="knowledgeItems.length === 0"
      :icon="BookOpen"
      :title="hasFilters ? t('knowledge.noKnowledgeMatchesTheFilters') : t('knowledge.noConfirmedKnowledgeYet')"
      :description="hasFilters ? t('common.adjustTheSearchOrFilters') : t('knowledge.itemsAppearHereOnceThe')"
    >
      <template v-if="hasFilters" #action
        ><UiButton @click="clearFilters">{{ t("common.clearFilters") }}</UiButton></template
      >
    </UiEmptyState>
    <VirtualList
      v-else
      :items="knowledgeItems"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="140"
      :label="t('knowledge.workKnowledgeList')"
    >
      <template #default="{ item }">
        <KnowledgeRow :item="item" @action="onAction" />
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination
        v-model:page-size="knowledgePageSize"
        :page-info="knowledgePageInfo"
        :size-label="t('knowledge.knowledgePerPage')"
        @page="knowledgePage = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.knowledge-search {
  display: flex;
  flex: 1 1 100%;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.knowledge-search__input {
  flex: 1;
}

.knowledge__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>

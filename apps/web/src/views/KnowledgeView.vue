<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
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
const pagesStore = useKnowledgePagesStore();
const { pages, pagesLoaded } = storeToRefs(pagesStore);

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
    label: t("知識頁"),
    icon: BookMarked,
    count: pagesLoaded.value ? pages.value.length : undefined,
  },
  {
    value: "candidates" as const,
    label: t("候選"),
    icon: Sparkles,
    count: candidatesLoaded.value ? candidates.value.length : undefined,
  },
  {
    value: "decisions" as const,
    label: t("待確認決策"),
    icon: ListChecks,
    count: decisionsLoaded.value ? pendingCount.value : undefined,
  },
]);
const projectItems = computed(() => [
  { value: "", label: t("所有記錄中專案") },
  ...knowledgeProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const kindItems = [
  { value: "" as const, label: t("所有類型") },
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
onBeforeUnmount(() => setKnowledgeListActive(false));
onBeforeUnmount(() => decisionStore.setListActive(false));
onBeforeUnmount(() => {
  pagesStore.setListActive(false);
  pagesStore.closePage();
});
</script>

<template>
  <PageHeader
    :description="t('Knowledge 只接受 Agent 明確提交、已確認的內容，不會自行讀取 source 或用猜測取代證據。')"
  />

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" :label="t('工作知識分頁')" id-prefix="knowledge" />
    <form v-if="tab === 'list'" class="knowledge-search" role="search" @submit.prevent="reloadNow">
      <UiTextInput
        v-model="knowledgeQuery"
        class="knowledge-search__input"
        type="search"
        :icon="Search"
        :label="t('搜尋 Knowledge')"
        :placeholder="t('搜尋標題、內容、標籤或參考')"
      />
      <UiButton v-if="hasFilters" :icon="X" @click="clearFilters">{{ t("清除篩選") }}</UiButton>
    </form>
  </PageToolbar>

  <UiFlash v-if="knowledgeError && tab === 'list'" tone="danger">
    {{ knowledgeError }}
    <template #actions
      ><UiButton size="sm" @click="retryKnowledge">{{ t("重試") }}</UiButton></template
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
            ? t('{total} 筆使用中 Knowledge', { total: knowledgePageInfo.total })
            : t('{total} 筆已封存 Knowledge', { total: knowledgePageInfo.total })
        "
      />
      <div class="knowledge__filters">
        <UiActionMenu
          v-model="knowledgeProjectId"
          :label="t('專案')"
          :header="t('篩選專案')"
          default-value=""
          align="end"
          :items="projectItems"
        />
        <UiActionMenu
          v-model="knowledgeKind"
          :label="t('類型')"
          :header="t('篩選類型')"
          default-value=""
          align="end"
          :items="kindItems"
        />
        <UiActionMenu
          v-model="knowledgeStatus"
          :label="t('狀態')"
          :header="t('篩選狀態')"
          default-value="active"
          align="end"
          :items="statusItems"
        />
      </div>
    </template>

    <UiSkeleton v-if="knowledgeLoading && knowledgeItems.length === 0" :count="4" :label="t('正在載入 Knowledge…')" />
    <UiEmptyState
      v-else-if="knowledgeItems.length === 0"
      :icon="BookOpen"
      :title="hasFilters ? t('沒有符合條件的 Knowledge') : t('還沒有已確認的 Knowledge')"
      :description="
        hasFilters
          ? t('調整搜尋或篩選條件後再試一次。')
          : t('Agent 明確提交 decision、pattern、gotcha、procedure 或 skill 後，會出現在這裡。')
      "
    >
      <template v-if="hasFilters" #action
        ><UiButton @click="clearFilters">{{ t("清除篩選") }}</UiButton></template
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
      :label="t('工作知識清單')"
    >
      <template #default="{ item }">
        <KnowledgeRow :item="item" @action="onAction" />
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination
        v-model:page-size="knowledgePageSize"
        :page-info="knowledgePageInfo"
        :size-label="t('Knowledge 每頁筆數')"
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

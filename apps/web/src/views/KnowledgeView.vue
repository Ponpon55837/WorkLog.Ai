<script setup lang="ts">
import { computed } from "vue";
import { BookOpen, Search, X } from "lucide-vue-next";
import type { KnowledgeKind, KnowledgeRecord, KnowledgeStatus } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import KnowledgeCandidateEditorDialog from "../components/domain/KnowledgeCandidateEditorDialog.vue";
import KnowledgeCandidatesBox from "../components/domain/KnowledgeCandidatesBox.vue";
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
import VirtualList from "../components/VirtualList.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { useKnowledge } from "../composables/useKnowledge";
import { useListReload } from "../composables/useListReload";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { knowledgeKindLabels, knowledgeStatusLabels, listPageSizeOptions } from "../utils/labels";
import { knowledgeKindVisual } from "../utils/status";

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
  loadKnowledge,
  setKnowledgeStatus,
  openKnowledgeSession,
  openKnowledgeStaleSession,
  confirmKnowledge,
  openKnowledgeEditor,
  openKnowledgeHistory,
} = useKnowledge();

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
useViewLoader(loadKnowledge);

const hasFilters = computed(() =>
  Boolean(
    knowledgeQuery.value || knowledgeKind.value || knowledgeProjectId.value || knowledgeStatus.value !== "active",
  ),
);
const selectedProjectRoot = computed(
  () => knowledgeProjects.value.find((project) => project.id === knowledgeProjectId.value)?.rootPath,
);
const projectItems = computed(() => [
  { value: "", label: "所有記錄中專案" },
  ...knowledgeProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const kindItems = [
  { value: "" as const, label: "所有類型" },
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
</script>

<template>
  <PageHeader description="Knowledge 只接受 Agent 明確提交、已確認的內容，不會自行讀取 source 或用猜測取代證據。" />

  <PageToolbar>
    <form class="knowledge-search" role="search" @submit.prevent="reloadNow">
      <UiTextInput
        v-model="knowledgeQuery"
        class="knowledge-search__input"
        type="search"
        :icon="Search"
        label="搜尋 Knowledge"
        placeholder="搜尋標題、內容、標籤或參考"
      />
      <UiButton v-if="hasFilters" :icon="X" @click="clearFilters">清除篩選</UiButton>
    </form>
  </PageToolbar>

  <UiFlash v-if="knowledgeError" tone="danger">
    {{ knowledgeError }}
    <template #actions><UiButton size="sm" @click="loadKnowledge">重試</UiButton></template>
  </UiFlash>

  <KnowledgeCandidatesBox :projects="knowledgeProjects" :project-root="selectedProjectRoot" />
  <KnowledgeCandidateEditorDialog :project-root="selectedProjectRoot" />

  <UiBox sticky-header>
    <template #header>
      <UiBoxTitle
        :icon="BookOpen"
        :title="`${knowledgePageInfo.total} 筆${knowledgeStatus === 'active' ? '使用中' : '已封存'} Knowledge`"
      />
      <div class="knowledge__filters">
        <UiActionMenu
          v-model="knowledgeProjectId"
          label="專案"
          header="篩選專案"
          default-value=""
          align="end"
          :items="projectItems"
        />
        <UiActionMenu
          v-model="knowledgeKind"
          label="類型"
          header="篩選類型"
          default-value=""
          align="end"
          :items="kindItems"
        />
        <UiActionMenu
          v-model="knowledgeStatus"
          label="狀態"
          header="篩選狀態"
          default-value="active"
          align="end"
          :items="statusItems"
        />
      </div>
    </template>

    <UiSkeleton v-if="knowledgeLoading && knowledgeItems.length === 0" :count="4" />
    <UiEmptyState
      v-else-if="knowledgeItems.length === 0"
      :icon="BookOpen"
      :title="hasFilters ? '沒有符合條件的 Knowledge' : '還沒有已確認的 Knowledge'"
      :description="
        hasFilters
          ? '調整搜尋或篩選條件後再試一次。'
          : 'Agent 明確提交 decision、pattern、gotcha、procedure 或 skill 後，會出現在這裡。'
      "
    >
      <template v-if="hasFilters" #action><UiButton @click="clearFilters">清除篩選</UiButton></template>
    </UiEmptyState>
    <VirtualList v-else :items="knowledgeItems" :enabled="true" :estimate-item-height="140" label="工作知識清單">
      <template #default="{ item }">
        <KnowledgeRow :item="item" @action="onAction" />
      </template>
    </VirtualList>

    <template #footer>
      <UiPagination
        v-model:page-size="knowledgePageSize"
        :page-info="knowledgePageInfo"
        size-label="Knowledge 每頁筆數"
        @page="knowledgePage = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.knowledge-search {
  display: flex;
  flex: 1;
  gap: var(--space-2);
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

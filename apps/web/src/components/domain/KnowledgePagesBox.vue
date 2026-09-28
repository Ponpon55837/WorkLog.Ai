<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { BookMarked, Eye, FilePlus2, RefreshCw } from "lucide-vue-next";
import { KNOWLEDGE_PAGE_DEFAULTS, type KnowledgePageRecord, type ProjectRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage, formatRelative } from "../../utils/format";
import { knowledgePageStatusVisual } from "../../utils/status";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import KnowledgePageRequestDialog from "./KnowledgePageRequestDialog.vue";
import StatusLabel from "./StatusLabel.vue";

/** A row is a saved page, or a default page the selected project has not requested yet. */
interface PageRow {
  key: string;
  projectId: string;
  slug: string;
  title: string;
  question: string;
  page?: KnowledgePageRecord;
}

/**
 * Standing Knowledge pages: new Sessions need assessment, cited-source changes need review, and only changed
 * answers need a rewrite. The Web UI views, edits, filters, and requests updates.
 */
const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const pagesStore = useKnowledgePagesStore();
const { pages, pagesLoading, pagesError } = storeToRefs(pagesStore);
const { showToast } = useToast();

const requestDialogOpen = ref(false);
const requesting = ref("");
const statusFilter = ref("all");

const projectsById = computed(() => new Map(props.projects.map((project) => [project.id, project])));
const selectedProject = computed(() => projectsById.value.get(projectId.value));
const projectItems = computed(() => [
  { value: "", label: "所有記錄中專案" },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const statusItems = [
  { value: "all", label: "所有狀態" },
  { value: "has_new_data", label: "有新資料" },
  { value: "needs_review", label: "來源需要核對" },
  { value: "fresh", label: "最新" },
  { value: "empty", label: "等待 Agent 撰寫" },
  { value: "missing", label: "尚未建立" },
  { value: "update_requested", label: "已要求更新" },
];
const rows = computed<PageRow[]>(() => {
  const saved: PageRow[] = pages.value.map((page) => ({
    key: page.id,
    projectId: page.projectId,
    slug: page.slug,
    title: page.title,
    question: page.question,
    page,
  }));
  const project = selectedProject.value;
  if (!project) return saved;
  const existing = new Set(saved.map((row) => row.slug));
  const missing = KNOWLEDGE_PAGE_DEFAULTS.filter((item) => !existing.has(item.slug)).map((item) => ({
    key: `missing-${item.slug}`,
    projectId: project.id,
    slug: item.slug,
    title: item.title,
    question: item.question,
  }));
  return [...missing, ...saved];
});
const waitingCount = computed(() => pages.value.filter((page) => page.updateRequestedAt).length);
const filteredRows = computed(() =>
  rows.value.filter((row) => {
    if (statusFilter.value === "all") return true;
    if (statusFilter.value === "needs_review") return Boolean(row.page?.needsReview);
    if (statusFilter.value === "update_requested") return Boolean(row.page?.updateRequestedAt);
    return (row.page?.status ?? "missing") === statusFilter.value;
  }),
);

async function requestUpdate(row: PageRow): Promise<void> {
  const project = projectsById.value.get(row.projectId);
  if (!project) {
    showToast("找不到這個知識頁所屬的記錄中專案。", "danger");
    return;
  }
  requesting.value = row.key;
  try {
    const result = await pagesStore.requestUpdate({ projectRoot: project.rootPath, slug: row.slug });
    if (result.outcome === "knowledge_page_update_requested") {
      showToast(`已要求 Agent 更新「${row.title}」。在 Claude Code 或 Codex 說「更新知識頁」即可。`, "success");
    } else {
      showToast(result.reason ?? "無法要求更新這個知識頁。", "danger");
    }
  } catch (error) {
    showToast(errorMessage(error, "無法要求更新這個知識頁。"), "danger");
  } finally {
    requesting.value = "";
  }
}
</script>

<template>
  <UiBox class="knowledge-pages" sticky-header data-testid="knowledge-pages">
    <template #header>
      <UiBoxTitle :icon="BookMarked" :title="`${pages.length} 個知識頁`" />
      <div class="knowledge-pages__tools">
        <UiActionMenu
          v-model="projectId"
          label="專案"
          header="篩選專案"
          default-value=""
          align="end"
          :items="projectItems"
        />
        <UiActionMenu
          v-model="statusFilter"
          label="狀態"
          header="篩選狀態"
          default-value="all"
          align="end"
          :items="statusItems"
        />
        <UiButton size="sm" :icon="FilePlus2" :disabled="!selectedProject" @click="requestDialogOpen = true"
          >自訂知識頁</UiButton
        >
      </div>
    </template>

    <UiFlash v-if="pagesError" tone="danger">{{ pagesError }}</UiFlash>
    <UiFlash v-if="waitingCount > 0" tone="accent">
      {{ waitingCount }} 個知識頁等待 Agent 更新。在 Claude Code 或 Codex 說「更新知識頁」即可。
    </UiFlash>

    <UiSkeleton v-if="pagesLoading && rows.length === 0" :count="3" />
    <UiEmptyState
      v-else-if="rows.length === 0"
      :icon="BookMarked"
      title="還沒有知識頁"
      description="選擇一個專案，就能要求 Agent 從已記錄的 Session 撰寫架構與慣例、進行中的工作與常見陷阱。"
    />
    <UiEmptyState
      v-else-if="filteredRows.length === 0"
      :icon="BookMarked"
      title="沒有符合狀態的知識頁"
      description="調整狀態篩選，即可查看其他知識頁。"
    />
    <VirtualList
      v-else
      :items="filteredRows"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="96"
      label="知識頁清單"
    >
      <template #default="{ item: row }">
        <UiBoxRow tag="article" data-testid="knowledge-page-row">
          <template #leading><BookMarked :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
          <template #title>{{ row.title }}</template>
          <template #labels>
            <StatusLabel :status="knowledgePageStatusVisual[row.page?.status ?? 'missing']" />
            <UiLabel v-if="row.page?.needsReview" tone="danger">來源需要核對</UiLabel>
            <UiLabel v-if="row.page && row.page.version > 0">第 {{ row.page.version }} 版</UiLabel>
            <UiLabel v-if="row.page?.updateRequestedAt" tone="accent">已要求更新</UiLabel>
          </template>
          <template #meta>
            <span v-if="!selectedProject">{{ projectsById.get(row.projectId)?.name ?? "未知專案" }} · </span>
            <span>{{ row.question }}</span>
            <span v-if="row.page?.sourcedThrough"> · 更新於 {{ formatRelative(row.page.sourcedThrough) }}</span>
            <span v-if="row.page && row.page.newSessionCount > 0">
              · 有 {{ row.page.newSessionCount }} 筆新 Session 待評估</span
            >
            <span v-if="row.page?.needsReview">
              · 需核對段落：{{ row.page.reviewSections?.map((section) => section.heading).join("、") }}</span
            >
          </template>
          <template #trailing>
            <div class="knowledge-pages__actions">
              <UiButton
                v-if="row.page && row.page.version > 0"
                size="sm"
                :icon="Eye"
                @click="pagesStore.showPage(row.page.id)"
                >查看</UiButton
              >
              <UiButton
                size="sm"
                :variant="!row.page ? 'primary' : 'default'"
                :icon="RefreshCw"
                :loading="requesting === row.key"
                @click="requestUpdate(row)"
                >{{ row.page ? "要求更新" : "要求建立" }}</UiButton
              >
            </div>
          </template>
        </UiBoxRow>
      </template>
    </VirtualList>

    <KnowledgePageRequestDialog
      :open="requestDialogOpen"
      :project="selectedProject"
      @close="requestDialogOpen = false"
    />
  </UiBox>
</template>

<style scoped>
.knowledge-pages__tools,
.knowledge-pages__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

@media (max-width: 639px) {
  .knowledge-pages__actions {
    justify-content: flex-start;
  }
}
</style>

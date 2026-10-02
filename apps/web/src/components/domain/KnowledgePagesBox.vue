<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { BookMarked, Eye, FilePlus2, RefreshCw } from "lucide-vue-next";
import { KNOWLEDGE_PAGE_DEFAULTS, type KnowledgePageRecord, type ProjectRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage, formatDate, formatRelative } from "../../utils/format";
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
import { t } from "../../i18n";

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
  { value: "", label: t("common.allTrackedProjects") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const statusItems = [
  { value: "all", label: t("knowledge.allStatuses") },
  { value: "has_new_data", label: t("common.newDataAvailable") },
  { value: "needs_review", label: t("knowledge.sourcesNeedChecking") },
  { value: "fresh", label: t("common.upToDate") },
  { value: "empty", label: t("common.waitingForTheAgentTo") },
  { value: "missing", label: t("common.notCreatedYet") },
  { value: "update_requested", label: t("knowledge.updateRequested") },
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
    showToast(t("knowledge.couldNotFindTheTrackedProjectThisKnowledge"), "danger");
    return;
  }
  requesting.value = row.key;
  try {
    const result = await pagesStore.requestUpdate({ projectRoot: project.rootPath, slug: row.slug });
    if (result.outcome === "knowledge_page_update_requested") {
      showToast(t("knowledge.requestedAnUpdateOfSay", { title: row.title }), "success");
    } else {
      showToast(result.reason ?? t("knowledge.couldNotRequestAnUpdate"), "danger");
    }
  } catch (error) {
    showToast(errorMessage(error, t("knowledge.couldNotRequestAnUpdate")), "danger");
  } finally {
    requesting.value = "";
  }
}
</script>

<template>
  <UiBox class="knowledge-pages" sticky-header data-testid="knowledge-pages">
    <template #header>
      <UiBoxTitle :icon="BookMarked" :title="t('knowledge.knowledgePages', { length: pages.length })" />
      <div class="knowledge-pages__tools">
        <UiActionMenu
          v-model="projectId"
          :label="t('common.project')"
          :header="t('common.filterProject')"
          default-value=""
          align="end"
          :items="projectItems"
        />
        <UiActionMenu
          v-model="statusFilter"
          :label="t('common.status')"
          :header="t('knowledge.filterStatus')"
          default-value="all"
          align="end"
          :items="statusItems"
        />
        <UiButton size="sm" :icon="FilePlus2" :disabled="!selectedProject" @click="requestDialogOpen = true">{{
          t("knowledge.customKnowledgePage")
        }}</UiButton>
      </div>
    </template>

    <UiFlash v-if="pagesError" tone="danger">{{ pagesError }}</UiFlash>
    <UiFlash v-if="waitingCount > 0" tone="accent">
      {{ t("knowledge.knowledgePagesAreWaitingFor", { waitingCount }) }}
    </UiFlash>

    <UiSkeleton v-if="pagesLoading && rows.length === 0" :count="3" :label="t('knowledge.loadingKnowledgePages')" />
    <UiEmptyState
      v-else-if="rows.length === 0"
      :icon="BookMarked"
      :title="t('knowledge.noKnowledgePagesYet')"
      :description="t('knowledge.chooseAProjectToHave')"
    />
    <UiEmptyState
      v-else-if="filteredRows.length === 0"
      :icon="BookMarked"
      :title="t('knowledge.noKnowledgePagesWithThis')"
      :description="t('knowledge.changeTheStatusFilterTo')"
    />
    <VirtualList
      v-else
      :items="filteredRows"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="96"
      :label="t('knowledge.knowledgePageList')"
    >
      <template #default="{ item: row }">
        <UiBoxRow tag="article" data-testid="knowledge-page-row">
          <template #leading><BookMarked :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
          <template #title>{{ row.title }}</template>
          <template #labels>
            <StatusLabel :status="knowledgePageStatusVisual[row.page?.status ?? 'missing']" />
            <UiLabel v-if="row.page?.needsReview" tone="danger">{{ t("knowledge.sourcesNeedChecking") }}</UiLabel>
            <UiLabel v-if="row.page && row.page.version > 0">{{
              t("knowledge.version", { version: row.page.version })
            }}</UiLabel>
            <UiLabel v-if="row.page?.updateRequestedAt" tone="accent">{{ t("knowledge.updateRequested") }}</UiLabel>
          </template>
          <template #meta>
            <span v-if="!selectedProject"
              >{{ `${projectsById.get(row.projectId)?.name ?? t("knowledge.unknownProject")} ·` }}
            </span>
            <span>{{ row.question }}</span>
            <span v-if="row.page?.sourcedThrough">
              {{ t("knowledge.updated", { value: formatRelative(row.page.sourcedThrough) }) }}</span
            >
            <time
              v-if="row.page && (row.page.checkedThrough?.completedAt || row.page.sourcedThrough)"
              :datetime="row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough"
              :title="
                t('knowledge.checkedThroughValue', {
                  value: formatDate(row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough!),
                })
              "
            >
              {{
                t("knowledge.checkedThrough", {
                  value: formatRelative(row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough!),
                })
              }}
            </time>
            <span v-else-if="row.page"> {{ t("knowledge.notCheckedYet") }}</span>
            <span v-if="row.page && row.page.newSessionCount > 0">
              {{ t("knowledge.newSessionsToAssess", { newSessionCount: row.page.newSessionCount }) }}</span
            >
            <span v-if="row.page?.needsReview">
              {{
                t("knowledge.sectionsToCheck", {
                  value: row.page.reviewSections?.map((section) => section.heading).join(t("common.listSeparator")),
                })
              }}</span
            >
          </template>
          <template #trailing>
            <div class="knowledge-pages__actions">
              <UiButton
                v-if="row.page && row.page.version > 0"
                size="sm"
                :icon="Eye"
                @click="pagesStore.showPage(row.page.id)"
                >{{ t("knowledge.view") }}</UiButton
              >
              <UiButton
                size="sm"
                :variant="!row.page ? 'primary' : 'default'"
                :icon="RefreshCw"
                :loading="requesting === row.key"
                @click="requestUpdate(row)"
                >{{ row.page ? t("knowledge.requestUpdate") : t("knowledge.requestCreation") }}</UiButton
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

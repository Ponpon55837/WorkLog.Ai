<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { BookMarked, Eye, FilePlus2, Sparkles } from "lucide-vue-next";
import { KNOWLEDGE_PAGE_DEFAULTS, type KnowledgePageRecord, type ProjectRecord } from "@work-intelligence/core";
import type { FilterChip } from "../ui/types";
import { useProjectChip } from "../../composables/useProjectChip";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage, formatDate, formatRelative } from "../../utils/format";
import { knowledgePageStatusVisual, requestStatus } from "../../utils/status";
import { filterChip } from "../../utils/filter-chips";
import AgentHandoffNotice from "./AgentHandoffNotice.vue";
import ProjectFilterMenu from "./ProjectFilterMenu.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFilterChips from "../ui/UiFilterChips.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiGroupLabel from "../ui/UiGroupLabel.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import KnowledgePageRequestDialog from "./KnowledgePageRequestDialog.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

interface PageRow {
  key: string;
  projectId: string;
  slug: string;
  title: string;
  question: string;
  page?: KnowledgePageRecord;
  group?: { title: string; count: number };
}

const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const pagesStore = useKnowledgePagesStore();
const { pages, pagesLoading, pagesError } = storeToRefs(pagesStore);
const { showToast } = useToast();

const projectChip = useProjectChip(projectId);

const requestDialogOpen = ref(false);
const requesting = ref("");
const statusFilter = ref("all");

const projectsById = computed(() => new Map(props.projects.map((project) => [project.id, project])));
const selectedProject = computed(() => projectsById.value.get(projectId.value));
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
const groupLabels = computed(() => {
  const ids = [...new Set(filteredRows.value.map((row) => row.projectId))];
  const names = new Map(ids.map((id) => [id, projectName(id)]));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    ids.map((id) => {
      const name = names.get(id) ?? "";
      return [id, (counts.get(name) ?? 0) > 1 ? `${name} · ${projectHint(id)}` : name];
    }),
  );
});
const listItems = computed<PageRow[]>(() => {
  if (selectedProject.value || groupLabels.value.size < 2) return filteredRows.value;
  const ids = [...groupLabels.value.keys()].sort(
    (a, b) => (groupLabels.value.get(a) ?? "").localeCompare(groupLabels.value.get(b) ?? "") || a.localeCompare(b),
  );
  return ids.flatMap((id) => {
    const members = filteredRows.value.filter((row) => row.projectId === id);
    const [first, ...rest] = members;
    return first
      ? [{ ...first, group: { title: groupLabels.value.get(id) ?? "", count: members.length } }, ...rest]
      : [];
  });
});
const filterChips = computed(() => {
  const chips: FilterChip[] = [];
  if (projectChip.value) chips.push(projectChip.value);
  const status = statusItems.find((item) => item.value === statusFilter.value);
  if (statusFilter.value !== "all" && status) chips.push(filterChip("status", t("common.status"), status.label));
  return chips;
});

function projectName(id: string): string {
  return projectsById.value.get(id)?.name ?? t("knowledge.unknownProject");
}

function projectHint(id: string): string {
  const root = projectsById.value.get(id)?.rootPath;
  return root ? root.split(/[\\/]/).filter(Boolean).slice(-2).join("/") : id.slice(0, 8);
}

function requestLabel(row: PageRow): string {
  if (row.page?.updateRequestedAt) return t("knowledge.pageRequested");
  return row.page ? t("knowledge.requestUpdate") : t("knowledge.requestCreation");
}

function isOpenable(row: PageRow): boolean {
  return Boolean(row.page && row.page.version > 0);
}

function openPage(row: PageRow): void {
  if (row.page && isOpenable(row)) pagesStore.showPage(row.page.id);
}

function removeFilter(key: string): void {
  if (key === "project") projectId.value = "";
  else statusFilter.value = "all";
}

function clearFilters(): void {
  projectId.value = "";
  statusFilter.value = "all";
}

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
      showToast(t("knowledge.pageUpdateRequested", { title: row.title }), "success");
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
        <ProjectFilterMenu v-model="projectId" :header="t('common.filterProject')" align="end" />
        <UiActionMenu
          v-model="statusFilter"
          :label="t('common.status')"
          :header="t('knowledge.filterStatus')"
          default-value="all"
          align="end"
          :items="statusItems"
        />
        <UiButton
          size="sm"
          :icon="FilePlus2"
          :disabled="projects.length === 0"
          :disabled-reason="t('projects.noTrackedProjects')"
          @click="requestDialogOpen = true"
          >{{ t("knowledge.customKnowledgePage") }}</UiButton
        >
      </div>
    </template>

    <UiFilterChips :chips="filterChips" clearable @remove="removeFilter" @clear="clearFilters" />
    <UiFlash v-if="pagesError" tone="danger">{{ pagesError }}</UiFlash>
    <div v-if="waitingCount > 0" class="knowledge-pages__handoff" data-testid="knowledge-pages-handoff">
      <AgentHandoffNotice
        :status="requestStatus.pending"
        :message="t('knowledge.knowledgePagesAreWaitingFor', { waitingCount })"
        :command="t('knowledge.pagesCommand')"
      />
    </div>

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
      :items="listItems"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="96"
      :label="t('knowledge.knowledgePageList')"
    >
      <template #default="{ item: row }">
        <UiGroupLabel v-if="row.group" :summary="t('knowledge.pageCount', { count: row.group.count })">{{
          row.group.title
        }}</UiGroupLabel>
        <UiBoxRow tag="article" :clickable="isOpenable(row)" data-testid="knowledge-page-row" @select="openPage(row)">
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
            <span class="knowledge-pages__meta-item">{{ row.question }}</span>
            <span v-if="row.page?.sourcedThrough" class="knowledge-pages__meta-item">{{
              t("knowledge.updated", { value: formatRelative(row.page.sourcedThrough) })
            }}</span>
            <time
              v-if="row.page && (row.page.checkedThrough?.completedAt || row.page.sourcedThrough)"
              class="knowledge-pages__meta-item"
              :datetime="row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough"
              :title="
                t('knowledge.checkedThroughValue', {
                  value: formatDate(row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough!),
                })
              "
              >{{
                t("knowledge.checkedThrough", {
                  value: formatRelative(row.page.checkedThrough?.completedAt ?? row.page.sourcedThrough!),
                })
              }}</time
            >
            <span v-else-if="row.page" class="knowledge-pages__meta-item">{{ t("knowledge.notCheckedYet") }}</span>
            <span v-if="row.page && row.page.newSessionCount > 0" class="knowledge-pages__meta-item">{{
              t("knowledge.newSessionsToAssess", { newSessionCount: row.page.newSessionCount })
            }}</span>
            <span v-if="row.page?.needsReview" class="knowledge-pages__meta-item">{{
              t("knowledge.sectionsToCheck", {
                value: row.page.reviewSections?.map((section) => section.heading).join(t("common.listSeparator")),
              })
            }}</span>
          </template>
          <template #trailing>
            <div class="knowledge-pages__actions">
              <UiButton v-if="isOpenable(row)" class="hide-sm" size="sm" :icon="Eye" @click="openPage(row)">{{
                t("knowledge.view")
              }}</UiButton>
              <UiButton
                size="sm"
                :variant="!row.page ? 'primary' : 'default'"
                :icon="Sparkles"
                :loading="requesting === row.key"
                :disabled="Boolean(row.page?.updateRequestedAt)"
                :disabled-reason="t('knowledge.pageRequestedReason')"
                @click="requestUpdate(row)"
                >{{ requestLabel(row) }}</UiButton
              >
            </div>
          </template>
        </UiBoxRow>
      </template>
    </VirtualList>

    <KnowledgePageRequestDialog
      :open="requestDialogOpen"
      :projects="projects"
      :default-project-id="projectId"
      @close="requestDialogOpen = false"
    />
  </UiBox>
</template>

<style scoped>
.knowledge-pages__handoff {
  padding: var(--space-3) var(--space-4);
}

.knowledge-pages__tools,
.knowledge-pages__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

.knowledge-pages__meta-item + .knowledge-pages__meta-item::before {
  content: "·";
  margin-inline: var(--space-2);
}

@media (max-width: 639px) {
  .knowledge-pages__actions {
    justify-content: flex-start;
  }
}
</style>

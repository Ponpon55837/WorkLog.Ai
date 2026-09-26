<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { Archive, FileInput, FolderGit2, History, Plus, ScanSearch, Trash2 } from "lucide-vue-next";
import type { ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import AddProjectDialog from "../components/domain/AddProjectDialog.vue";
import DeleteProjectDialog from "../components/domain/DeleteProjectDialog.vue";
import BackupSection from "../components/domain/BackupSection.vue";
import MetadataBackfillSection from "../components/domain/MetadataBackfillSection.vue";
import ProjectDeletionAuditSection from "../components/domain/ProjectDeletionAuditSection.vue";
import StatusLabel from "../components/domain/StatusLabel.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import VirtualList from "../components/VirtualList.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { useHandoffImport } from "../composables/useHandoffImport";
import { useMetadataBackfill } from "../composables/useMetadataBackfill";
import { useProjects } from "../composables/useProjects";
import { router } from "../router";
import { formatDate, formatRelative } from "../utils/format";
import { statusDescriptions, statusLabels } from "../utils/labels";
import { trackingStatus } from "../utils/status";

type ProjectsTab = "registry" | "backfill" | "import" | "backup" | "deletion-audit";

const route = useRoute();
const {
  projects,
  projectDeletionAudits,
  projectDeletionAuditsLoading,
  projectDeletionAuditsError,
  trackedProjects,
  loadProjects,
  loadProjectDeletionAudits,
  updateProjectStatus,
  deleteProject,
  deletingProjectId,
  projectDeletionNotice,
  clearProjectDeletionNotice,
} = useProjects();
const { loadMetadataBackfillRequest } = useMetadataBackfill();
const { handoffImportLoading, handoffImportProjectId, previewHandoffs } = useHandoffImport();

useViewLoader(() => Promise.all([loadProjects(), loadMetadataBackfillRequest(), loadProjectDeletionAudits()]));

const addOpen = ref(false);
const deleteTarget = ref<ProjectRecord | null>(null);
const policyDismissed = ref(readDismissed());
/** Bumped after every status change so a cancelled confirm re-renders the select to the saved value. */
const statusRevision = ref(0);

const tab = computed<ProjectsTab>({
  get: () =>
    ["registry", "backfill", "import", "backup", "deletion-audit"].includes(String(route.params.tab))
      ? (route.params.tab as ProjectsTab)
      : "registry",
  set: (value) => void router.replace({ name: "projects", params: { tab: value === "registry" ? undefined : value } }),
});
const tabs = computed(() => [
  { value: "registry" as const, label: "專案清單", icon: FolderGit2, count: projects.value.length },
  { value: "backfill" as const, label: "Metadata 回補", icon: ScanSearch },
  { value: "import" as const, label: "Handoff 匯入", icon: FileInput, count: trackedProjects.value.length },
  { value: "backup" as const, label: "資料備份", icon: Archive },
  { value: "deletion-audit" as const, label: "刪除紀錄", icon: History },
]);
const statusOptions = (Object.keys(statusLabels) as ProjectStatus[]).map((status) => ({
  value: status,
  label: statusLabels[status],
}));

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem("wi.projects.policyDismissed") === "1";
  } catch {
    return false;
  }
}

function dismissPolicy(): void {
  policyDismissed.value = true;
  try {
    window.localStorage.setItem("wi.projects.policyDismissed", "1");
  } catch {
    // Storage may be unavailable (private mode); the flash simply returns next visit.
  }
}

async function changeStatus(project: ProjectRecord, status: ProjectStatus): Promise<void> {
  await updateProjectStatus(project, status);
  statusRevision.value += 1;
}

async function confirmDelete(project: ProjectRecord, confirmationName: string): Promise<void> {
  if (await deleteProject(project, confirmationName)) {
    deleteTarget.value = null;
  }
}
</script>

<template>
  <PageHeader description="你決定哪些專案值得被記住。Registry 只存在中央 SQLite，不會寫入任何專案 repo。">
    <template #actions>
      <UiButton variant="primary" :icon="Plus" @click="addOpen = true">加入專案</UiButton>
    </template>
  </PageHeader>

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" label="專案管理分頁" id-prefix="projects" />
  </PageToolbar>

  <UiFlash
    v-if="projectDeletionNotice"
    tone="attention"
    title="專案資料已刪除，備份仍保留資料"
    dismissible
    @dismiss="clearProjectDeletionNotice"
  >
    「{{ projectDeletionNotice.projectName }}」的刪除前備份
    {{ projectDeletionNotice.backupFileName }} 仍包含專案資料；其他既有備份也可能保留副本。
    <template #actions>
      <RouterLink :to="{ name: 'projects', params: { tab: 'backup' } }">前往資料備份管理</RouterLink>
    </template>
  </UiFlash>

  <section
    v-if="tab === 'registry'"
    id="projects-panel-registry"
    role="tabpanel"
    aria-labelledby="projects-tab-registry"
  >
    <UiFlash v-if="!policyDismissed" tone="accent" title="Default deny" dismissible @dismiss="dismissPolicy">
      任何 handoff、Git 或 source 讀取，都必須先通過 project policy gate：專案被發現 → 你明確切換為「記錄中」→ Agent
      才能 finalize Session。
    </UiFlash>
    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle :icon="FolderGit2" title="所有專案" :count="projects.length" />
        <span class="projects__tracked">{{ trackedProjects.length }} 個記錄中</span>
      </template>
      <UiEmptyState
        v-if="projects.length === 0"
        :icon="FolderGit2"
        title="還沒有專案"
        description="加入第一個 workspace，建立你的中央 project registry。"
      >
        <template #action
          ><UiButton variant="primary" :icon="Plus" @click="addOpen = true">加入專案</UiButton></template
        >
      </UiEmptyState>
      <VirtualList v-else :items="projects" :enabled="true" fit-viewport :estimate-item-height="128" label="專案清單">
        <template #default="{ item: project }">
          <UiBoxRow :title="project.name" data-testid="project-row">
            <template #leading
              ><component :is="trackingStatus[project.status].icon" :size="16" :stroke-width="1.75" aria-hidden="true"
            /></template>
            <template #labels><StatusLabel :status="trackingStatus[project.status]" :show-icon="false" /></template>
            <template #meta
              ><code>{{ project.rootPath }}</code></template
            >
            <p class="projects__description">
              {{ statusDescriptions[project.status] }}
              <span v-if="project.lastIngestedAt" class="projects__ingest"
                >最後寫入
                <time :title="formatDate(project.lastIngestedAt)">{{
                  formatRelative(project.lastIngestedAt)
                }}</time></span
              >
            </p>
            <template #trailing>
              <UiSelect
                :key="`${project.id}-${project.status}-${statusRevision}`"
                :model-value="project.status"
                :options="statusOptions"
                size="sm"
                :label="`更新 ${project.name} 的專案記錄狀態`"
                @update:model-value="changeStatus(project, $event)"
              />
              <UiButton
                variant="danger"
                size="sm"
                :icon="Trash2"
                icon-only
                :label="`永久刪除 ${project.name}`"
                :disabled="deletingProjectId === project.id"
                @click="deleteTarget = project"
              />
            </template>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
  </section>

  <section
    v-else-if="tab === 'backfill'"
    id="projects-panel-backfill"
    role="tabpanel"
    aria-labelledby="projects-tab-backfill"
  >
    <MetadataBackfillSection />
  </section>

  <section
    v-else-if="tab === 'backup'"
    id="projects-panel-backup"
    role="tabpanel"
    aria-labelledby="projects-tab-backup"
  >
    <BackupSection />
  </section>

  <section
    v-else-if="tab === 'deletion-audit'"
    id="projects-panel-deletion-audit"
    role="tabpanel"
    aria-labelledby="projects-tab-deletion-audit"
  >
    <ProjectDeletionAuditSection
      :items="projectDeletionAudits"
      :loading="projectDeletionAuditsLoading"
      :error="projectDeletionAuditsError"
      @retry="loadProjectDeletionAudits"
    />
  </section>

  <section v-else id="projects-panel-import" role="tabpanel" aria-labelledby="projects-tab-import">
    <UiBox>
      <template #header>
        <UiBoxTitle eyebrow="Handoff import" title="匯入歷史 handoff" />
      </template>
      <UiEmptyState
        v-if="trackedProjects.length === 0"
        compact
        :icon="FileInput"
        title="沒有記錄中的專案"
        description="只有「記錄中」的專案可以預覽與匯入 handoff。"
      >
        <template #action><UiButton @click="tab = 'registry'">前往專案清單</UiButton></template>
      </UiEmptyState>
      <VirtualList
        v-else
        :items="trackedProjects"
        :enabled="true"
        fit-viewport
        :estimate-item-height="80"
        label="Handoff 匯入專案清單"
      >
        <template #default="{ item: project }">
          <UiBoxRow :title="project.name">
            <template #leading><FolderGit2 :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
            <template #meta
              ><code>{{ project.rootPath }}</code></template
            >
            <template #trailing>
              <UiButton
                size="sm"
                :icon="FileInput"
                :loading="handoffImportLoading && handoffImportProjectId === project.id"
                @click="previewHandoffs(project)"
                >預覽 handoff</UiButton
              >
            </template>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
  </section>

  <AddProjectDialog v-model:open="addOpen" />
  <DeleteProjectDialog
    :open="!!deleteTarget"
    :project="deleteTarget"
    :busy="!!deleteTarget && deletingProjectId === deleteTarget.id"
    @close="deleteTarget = null"
    @confirm="confirmDelete"
  />
</template>

<style scoped>
.projects__tracked {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.projects__description {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.projects__ingest {
  display: block;
}
</style>

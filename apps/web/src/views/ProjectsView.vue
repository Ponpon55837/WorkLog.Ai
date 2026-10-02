<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { RouterLink, useRoute } from "vue-router";
import {
  Archive,
  FileInput,
  FolderGit2,
  GitCommitHorizontal,
  History,
  Plus,
  ScanSearch,
  Trash2,
} from "lucide-vue-next";
import type { ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import AddProjectDialog from "../components/domain/AddProjectDialog.vue";
import DeleteProjectDialog from "../components/domain/DeleteProjectDialog.vue";
import ProjectRepositoryDialog from "../components/domain/ProjectRepositoryDialog.vue";
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
import { router } from "../router";
import { useHandoffImportStore } from "../stores/handoff-import";
import { useMetadataBackfillStore } from "../stores/metadata-backfill";
import { useProjectsStore } from "../stores/projects";
import { formatDate, formatRelative } from "../utils/format";
import { statusDescriptions, statusLabels } from "../utils/labels";
import { trackingStatus } from "../utils/status";
import { t } from "../i18n";

type ProjectsTab = "registry" | "backfill" | "import" | "backup" | "deletion-audit";

const route = useRoute();
const projectsStore = useProjectsStore();
const { projects, projectDeletionAudits, projectDeletionAuditsLoading, projectDeletionAuditsError, trackedProjects } =
  storeToRefs(projectsStore);
const {
  loadProjectDeletionAudits,
  setProjectDeletionAuditsActive,
  updateProjectStatus,
  updateProjectLocation,
  deleteProject,
} = projectsStore;
const metadataBackfillStore = useMetadataBackfillStore();
const handoffImportStore = useHandoffImportStore();
const { handoffImportLoading, handoffImportProjectId } = storeToRefs(handoffImportStore);
const { previewHandoffs } = handoffImportStore;

const addOpen = ref(false);
const deleteTarget = ref<ProjectRecord | null>(null);
const repositoryTarget = ref<ProjectRecord | null>(null);
const deletingProjectId = ref<string | null>(null);
const projectDeletionNotice = ref<{ projectName: string; backupFileName: string } | null>(null);
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
const metadataBackfillActive = computed(() => tab.value === "backfill");

const tabs = computed(() => [
  { value: "registry" as const, label: t("projects.projectList"), icon: FolderGit2, count: projects.value.length },
  { value: "backfill" as const, label: t("projects.metadataBackfill"), icon: ScanSearch },
  {
    value: "import" as const,
    label: t("projects.handoffImport"),
    icon: FileInput,
    count: trackedProjects.value.length,
  },
  { value: "backup" as const, label: t("projects.dataBackup"), icon: Archive },
  { value: "deletion-audit" as const, label: t("projects.deletionHistory"), icon: History },
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
  projectDeletionNotice.value = null;
  deletingProjectId.value = project.id;
  try {
    const notice = await deleteProject(project, confirmationName);
    if (notice) {
      projectDeletionNotice.value = notice;
      deleteTarget.value = null;
    }
  } finally {
    deletingProjectId.value = null;
  }
}

function clearProjectDeletionNotice(): void {
  projectDeletionNotice.value = null;
}

watch(metadataBackfillActive, metadataBackfillStore.setMetadataBackfillActive, { immediate: true });
watch(() => tab.value === "deletion-audit", setProjectDeletionAuditsActive, { immediate: true });

onBeforeUnmount(() => {
  metadataBackfillStore.setMetadataBackfillActive(false);
  setProjectDeletionAuditsActive(false);
});
</script>

<template>
  <PageHeader :description="t('projects.youDecideWhichProjectsAre')">
    <template #actions>
      <UiButton variant="primary" :icon="Plus" @click="addOpen = true">{{ t("common.addProject") }}</UiButton>
    </template>
  </PageHeader>

  <PageToolbar>
    <UiUnderlineNav v-model="tab" :items="tabs" :label="t('projects.projectManagementTabs')" id-prefix="projects" />
  </PageToolbar>

  <UiFlash
    v-if="projectDeletionNotice"
    tone="attention"
    :title="t('projects.projectDataDeletedTheBackup')"
    dismissible
    @dismiss="clearProjectDeletionNotice"
  >
    {{
      t("projects.thePreDeletionBackupOf", {
        projectName: projectDeletionNotice.projectName,
        backupFileName: projectDeletionNotice.backupFileName,
      })
    }}
    <template #actions>
      <RouterLink :to="{ name: 'projects', params: { tab: 'backup' } }">{{
        t("projects.goToBackupManagement")
      }}</RouterLink>
    </template>
  </UiFlash>

  <section
    v-if="tab === 'registry'"
    id="projects-panel-registry"
    role="tabpanel"
    aria-labelledby="projects-tab-registry"
  >
    <UiFlash
      v-if="!policyDismissed"
      tone="accent"
      :title="t('projects.defaultDeny')"
      dismissible
      @dismiss="dismissPolicy"
    >
      {{ t("projects.everyHandoffGitOrSource") }}
    </UiFlash>
    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle :icon="FolderGit2" :title="t('common.allProjects')" :count="projects.length" />
        <span class="projects__tracked">{{ t("projects.tracked", { length: trackedProjects.length }) }}</span>
      </template>
      <UiEmptyState
        v-if="projects.length === 0"
        :icon="FolderGit2"
        :title="t('projects.noProjectsYet')"
        :description="t('projects.addYourFirstWorkspaceTo')"
      >
        <template #action
          ><UiButton variant="primary" :icon="Plus" @click="addOpen = true">{{
            t("common.addProject")
          }}</UiButton></template
        >
      </UiEmptyState>
      <VirtualList
        v-else
        :items="projects"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        :estimate-item-height="128"
        :label="t('projects.projectList')"
      >
        <template #default="{ item: project }">
          <UiBoxRow :title="project.name" data-testid="project-row">
            <template #leading
              ><component :is="trackingStatus[project.status].icon" :size="16" :stroke-width="1.75" aria-hidden="true"
            /></template>
            <template #labels><StatusLabel :status="trackingStatus[project.status]" :show-icon="false" /></template>
            <template #meta
              ><code>{{ project.rootPath }}</code
              ><template v-if="project.repositoryUrl">
                ·
                <a
                  class="projects__repository-link"
                  :href="project.repositoryUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ project.repositoryUrl }}</a
                ></template
              ></template
            >
            <p class="projects__description">
              {{ statusDescriptions[project.status] }}
              <span v-if="project.lastIngestedAt" class="projects__ingest"
                >{{ t("projects.lastWritten") }}
                <time :title="formatDate(project.lastIngestedAt)">{{
                  formatRelative(project.lastIngestedAt)
                }}</time></span
              >
              <span v-if="project.folderStatus === 'missing'" class="projects__location-status">{{
                t("projects.folderNotFound")
              }}</span>
              <span v-else-if="project.folderStatus === 'unavailable'" class="projects__location-status">{{
                t("projects.cannotCheckTheFolder")
              }}</span>
            </p>
            <template #trailing>
              <UiSelect
                :key="`${project.id}-${project.status}-${statusRevision}`"
                :model-value="project.status"
                :options="statusOptions"
                size="sm"
                :label="t('projects.updateTheTrackingStatusOf', { name: project.name })"
                @update:model-value="changeStatus(project, $event)"
              />
              <UiButton
                v-if="project.folderStatus === 'missing'"
                size="sm"
                :icon="FolderGit2"
                :label="t('projects.relocate', { name: project.name })"
                @click="updateProjectLocation(project)"
                >{{ t("projects.relocateAction") }}</UiButton
              >
              <UiButton
                size="sm"
                :icon="GitCommitHorizontal"
                icon-only
                :label="t('projects.setRepositoryUrlLabel', { name: project.name })"
                @click="repositoryTarget = project"
              />
              <UiButton
                variant="danger"
                size="sm"
                :icon="Trash2"
                icon-only
                :label="t('projects.permanentlyDelete', { name: project.name })"
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
        <UiBoxTitle eyebrow="Handoff import" :title="t('projects.importPastHandoffs')" />
      </template>
      <UiEmptyState
        v-if="trackedProjects.length === 0"
        compact
        :icon="FileInput"
        :title="t('projects.noTrackedProjects')"
        :description="t('projects.onlyTrackedProjectsCanPreview')"
      >
        <template #action
          ><UiButton @click="tab = 'registry'">{{ t("projects.goToProjectList") }}</UiButton></template
        >
      </UiEmptyState>
      <VirtualList
        v-else
        :items="trackedProjects"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        :estimate-item-height="80"
        :label="t('projects.handoffImportProjectList')"
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
                >{{ t("projects.previewHandoffs") }}</UiButton
              >
            </template>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
  </section>

  <AddProjectDialog v-model:open="addOpen" />
  <ProjectRepositoryDialog :project="repositoryTarget" @close="repositoryTarget = null" />
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

.projects__repository-link {
  text-decoration: underline;
}

.projects__description {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.projects__ingest {
  display: block;
}

.projects__location-status {
  display: block;
  color: var(--danger);
  font-size: var(--text-xs);
}
</style>

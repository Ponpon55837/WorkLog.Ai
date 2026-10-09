import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { DashboardSummary, ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { statusLabels } from "../utils/labels";
import { useApi } from "../composables/useApi";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

type ProjectInput = { name: string; rootPath: string };
type ProjectDeletionNotice = { projectName: string; backupFileName: string };

const emptyDashboard: DashboardSummary = {
  trackedProjects: 0,
  activeProjects: 0,
  finalizedSessions: 0,
  recordedEvents: 0,
  recentSessions: [],
};

/** Owns project and dashboard server state plus project mutations. */
export const useProjectsStore = defineStore("projects", () => {
  const queryCache = useQueryCache();
  const dashboardEnabled = ref(false);
  const projectsEnabled = ref(false);
  const deletionAuditsEnabled = ref(false);

  const dashboardQuery = useQuery({
    key: queryKeys.dashboard.summary,
    enabled: dashboardEnabled,
    query: ({ signal }) => useApi().client.getDashboard(signal),
  });
  const projectsQuery = useQuery({
    key: queryKeys.projects.list,
    enabled: projectsEnabled,
    query: ({ signal }) => useApi().client.listProjects(signal),
  });
  const projectDeletionAuditsQuery = useQuery({
    key: queryKeys.projects.deletionAudits,
    enabled: deletionAuditsEnabled,
    query: ({ signal }) => useApi().client.listProjectDeletionAudits(signal),
  });

  const dashboard = computed(() => dashboardQuery.data.value ?? emptyDashboard);
  const projects = computed(() => projectsQuery.data.value ?? []);
  const initialDataReady = computed(
    () => dashboardQuery.data.value !== undefined && projectsQuery.data.value !== undefined,
  );
  const trackedProjects = computed(() => projects.value.filter((project) => project.status === "tracked"));
  const recentSessions = computed(() => dashboard.value.recentSessions);
  const projectDeletionAudits = computed(() => projectDeletionAuditsQuery.data.value ?? []);
  const projectDeletionAuditsLoading = computed(() => projectDeletionAuditsQuery.isLoading.value);
  const projectDeletionAuditsError = computed(() =>
    projectDeletionAuditsQuery.error.value
      ? errorMessage(projectDeletionAuditsQuery.error.value, t("projects.couldNotLoadDeletionHistorySentence"))
      : null,
  );

  const addProjectMutation = useMutation({
    mutation: (input: ProjectInput) => useApi().client.createProject(input),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
      ]);
    },
  });
  const updateProjectStatusMutation = useMutation({
    mutation: ({ projectId, status }: { projectId: string; status: ProjectStatus }) =>
      useApi().client.updateProject(projectId, { status }),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.activity }),
        queryCache.invalidateQueries({ key: queryKeys.views.reports }),
      ]);
    },
  });
  const updateProjectRepositoryMutation = useMutation({
    mutation: ({ projectId, repositoryUrl }: { projectId: string; repositoryUrl: string | null }) =>
      useApi().client.updateProject(projectId, { repositoryUrl }),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
      ]);
    },
  });
  const updateProjectLocationMutation = useMutation({
    mutation: ({
      projectId,
      rootPath,
      confirmedTrackedScope,
    }: {
      projectId: string;
      rootPath: string;
      confirmedTrackedScope: boolean;
    }) => useApi().client.updateProjectLocation(projectId, { rootPath, confirmedTrackedScope }),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.projects.handoffImportPreview }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph }),
      ]);
    },
  });
  const deleteProjectMutation = useMutation({
    mutation: ({ projectId, confirmationName }: { projectId: string; confirmationName: string }) =>
      useApi().client.deleteProject(projectId, confirmationName),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.projects.deletionAudits, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.projects.backups, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.activity }),
        queryCache.invalidateQueries({ key: queryKeys.views.reports }),
        queryCache.invalidateQueries({ key: queryKeys.views.systemStatus, exact: true }),
      ]);
    },
  });

  const addingProject = computed(() => addProjectMutation.isLoading.value);

  async function loadDashboard(): Promise<void> {
    dashboardEnabled.value = true;
    try {
      await dashboardQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        throw error;
      }
    }
  }

  async function loadProjects(): Promise<void> {
    projectsEnabled.value = true;
    try {
      await projectsQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        throw error;
      }
    }
  }

  async function loadProjectDeletionAudits(): Promise<void> {
    deletionAuditsEnabled.value = true;
    const result = await projectDeletionAuditsQuery.refetch();
    if (result.status !== "success") deletionAuditsEnabled.value = false;
  }

  function setProjectDeletionAuditsActive(active: boolean): void {
    deletionAuditsEnabled.value = active;
  }

  /** Opens the native folder picker and returns its selection for the dialog's local form state. */
  async function pickProjectFolder(): Promise<{ path: string; name: string } | null> {
    const { showToast } = useToast();
    try {
      const result = await useApi().client.pickFolder();
      if (result.outcome === "folder_picked") {
        return { path: result.path, name: result.name };
      }
      if (result.outcome === "folder_pick_busy") {
        showToast(t("projects.aFolderPickerIsAlready"));
      } else if (result.outcome === "folder_pick_unavailable") {
        showToast(t("projects.thisComputerCannotOpenA"), "danger");
      }
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotOpenTheFolder")), "danger");
    }
    return null;
  }

  async function addProject(input: ProjectInput): Promise<boolean> {
    const { showToast } = useToast();
    if (!input.name.trim() || !input.rootPath.trim()) {
      showToast(t("projects.enterAProjectNameAnd"), "danger");
      return false;
    }

    try {
      await addProjectMutation.mutateAsync(input);
      showToast(t("projects.theProjectWasAddedTo"), "success");
      return true;
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotAddTheProject")), "danger");
      return false;
    }
  }

  async function updateProjectStatus(project: ProjectRecord, status: ProjectStatus): Promise<void> {
    const { showToast } = useToast();
    if (status === project.status) {
      return;
    }
    // Enabling tracking widens what Agents may read, so it is the one status change that needs consent.
    if (
      status === "tracked" &&
      !(await confirmAction({
        title: t("projects.switchToTracked", { name: project.name }),
        message: t("projects.onceTrackedTheAgentCan"),
        confirmLabel: t("projects.startTracking"),
      }))
    ) {
      return;
    }
    try {
      const updated = await updateProjectStatusMutation.mutateAsync({ projectId: project.id, status });
      showToast(
        t("projects.projectStatusChanged", { name: updated.name, value: statusLabels[updated.status] }),
        "success",
      );
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotUpdateTheProject")), "danger");
    }
  }

  /** Saves or clears (empty string) the https repository URL used for commit links; the API validates it. */
  async function updateProjectRepository(project: ProjectRecord, repositoryUrl: string): Promise<boolean> {
    const { showToast } = useToast();
    try {
      await updateProjectRepositoryMutation.mutateAsync({
        projectId: project.id,
        repositoryUrl: repositoryUrl.trim() || null,
      });
      showToast(
        repositoryUrl.trim()
          ? t("projects.setTheRepositoryUrlOf", { name: project.name })
          : t("projects.removedTheRepositoryUrlOf", { name: project.name }),
        "success",
      );
      return true;
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotUpdateTheRepository")), "danger");
      return false;
    }
  }

  async function updateProjectLocation(project: ProjectRecord): Promise<void> {
    const { showToast } = useToast();
    const selected = await pickProjectFolder();
    if (!selected) return;

    const confirmedTrackedScope =
      project.status === "tracked" &&
      (await confirmAction({
        title: t("projects.relocateConfirm", { name: project.name }),
        message: t("projects.thisProjectIsBeingTracked"),
        confirmLabel: t("projects.confirmNewLocation"),
      }));
    if (project.status === "tracked" && !confirmedTrackedScope) return;

    try {
      const updated = await updateProjectLocationMutation.mutateAsync({
        projectId: project.id,
        rootPath: selected.path,
        confirmedTrackedScope,
      });
      showToast(t("projects.locationOfUpdated", { name: updated.name }), "success");
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotRelocateTheProject")), "danger");
    }
  }

  async function deleteProject(
    project: ProjectRecord,
    confirmationName: string,
  ): Promise<ProjectDeletionNotice | null> {
    const { showToast } = useToast();
    try {
      const result = await deleteProjectMutation.mutateAsync({ projectId: project.id, confirmationName });
      showToast(
        t("projects.projectPermanentlyDeletedPreDeletion", { backupFileName: result.backupFileName }),
        "success",
      );
      return { projectName: project.name, backupFileName: result.backupFileName };
    } catch (error) {
      showToast(errorMessage(error, t("projects.theDeletionDidNotFinish")), "danger");
      return null;
    }
  }

  return {
    dashboard,
    projects,
    initialDataReady,
    trackedProjects,
    recentSessions,
    projectDeletionAudits,
    projectDeletionAuditsLoading,
    projectDeletionAuditsError,
    addingProject,
    loadDashboard,
    loadProjects,
    loadProjectDeletionAudits,
    setProjectDeletionAuditsActive,
    pickProjectFolder,
    addProject,
    updateProjectStatus,
    updateProjectRepository,
    updateProjectLocation,
    deleteProject,
  };
});

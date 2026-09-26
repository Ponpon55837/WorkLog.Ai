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
  const trackedProjects = computed(() => projects.value.filter((project) => project.status === "tracked"));
  const recentSessions = computed(() => dashboard.value.recentSessions);
  const projectDeletionAudits = computed(() => projectDeletionAuditsQuery.data.value ?? []);
  const projectDeletionAuditsLoading = computed(() => projectDeletionAuditsQuery.isLoading.value);
  const projectDeletionAuditsError = computed(() =>
    projectDeletionAuditsQuery.error.value
      ? errorMessage(projectDeletionAuditsQuery.error.value, "無法載入刪除紀錄。")
      : null,
  );

  const addProjectMutation = useMutation({
    mutation: (input: ProjectInput) => useApi().client.createProject(input),
    onSuccess: async () => {
      await Promise.all([
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
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.views.reports }),
      ]);
    },
  });
  const deleteProjectMutation = useMutation({
    mutation: ({ projectId, confirmationName }: { projectId: string; confirmationName: string }) =>
      useApi().client.deleteProject(projectId, confirmationName),
    onSuccess: async () => {
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.projects.deletionAudits, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.projects.backups, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
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
        showToast("已經有一個選擇資料夾視窗開著，請先在那個視窗完成選擇。");
      } else if (result.outcome === "folder_pick_unavailable") {
        showToast("這台電腦無法開啟選擇資料夾視窗，請直接輸入路徑。", "danger");
      }
    } catch (error) {
      showToast(errorMessage(error, "無法開啟選擇資料夾視窗。"), "danger");
    }
    return null;
  }

  async function addProject(input: ProjectInput): Promise<boolean> {
    const { showToast } = useToast();
    if (!input.name.trim() || !input.rootPath.trim()) {
      showToast("請填寫專案名稱與根目錄。", "danger");
      return false;
    }

    try {
      await addProjectMutation.mutateAsync(input);
      showToast("專案已加入 registry；目前仍是未註冊狀態。請明確切換為記錄中。", "success");
      return true;
    } catch (error) {
      showToast(errorMessage(error, "加入專案失敗。"), "danger");
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
        title: `將「${project.name}」切換為記錄中？`,
        message:
          "切換後，Agent 可以在這個專案讀取 handoff、Git／worktree 與 source 並保存工作紀錄。其他狀態會安靜略過所有讀取。",
        confirmLabel: "開始記錄",
      }))
    ) {
      return;
    }
    try {
      const updated = await updateProjectStatusMutation.mutateAsync({ projectId: project.id, status });
      showToast(`${updated.name}：${statusLabels[updated.status]}`, "success");
    } catch (error) {
      showToast(errorMessage(error, "更新專案狀態失敗。"), "danger");
    }
  }

  async function deleteProject(
    project: ProjectRecord,
    confirmationName: string,
  ): Promise<ProjectDeletionNotice | null> {
    const { showToast } = useToast();
    try {
      const result = await deleteProjectMutation.mutateAsync({ projectId: project.id, confirmationName });
      showToast(`專案已永久刪除；刪除前資料庫備份：${result.backupFileName}`, "success");
      return { projectName: project.name, backupFileName: result.backupFileName };
    } catch (error) {
      showToast(errorMessage(error, "刪除作業未完成；請確認 API 與資料庫狀態後再試。"), "danger");
      return null;
    }
  }

  return {
    dashboard,
    projects,
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
    deleteProject,
  };
});

import { computed, ref } from "vue";
import type { DashboardSummary, ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import { statusLabels } from "../utils/labels";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

const emptyDashboard: DashboardSummary = {
  trackedProjects: 0,
  activeProjects: 0,
  finalizedSessions: 0,
  recordedEvents: 0,
  recentSessions: [],
};

const dashboard = ref<DashboardSummary>(emptyDashboard);
const projects = ref<ProjectRecord[]>([]);
const projectName = ref("");
const projectRoot = ref("");
const addingProject = ref(false);
const pickingFolder = ref(false);
const trackedProjects = computed(() => projects.value.filter((project) => project.status === "tracked"));
const recentSessions = computed(() => dashboard.value.recentSessions);

async function loadDashboard(): Promise<void> {
  await runKeyed("dashboard", async (signal) => {
    dashboard.value = await useApi().client.getDashboard(signal);
  });
}

async function loadProjects(): Promise<void> {
  await runKeyed("projects", async (signal) => {
    projects.value = await useApi().client.listProjects(signal);
  });
}

/** Fills the project root from the native folder dialog, and the name from the folder when it is empty. */
async function pickProjectFolder(): Promise<void> {
  const { showToast } = useToast();
  pickingFolder.value = true;
  try {
    const result = await useApi().client.pickFolder();
    if (result.outcome === "folder_picked") {
      projectRoot.value = result.path;
      if (!projectName.value.trim()) {
        projectName.value = result.name;
      }
    } else if (result.outcome === "folder_pick_busy") {
      showToast("已經有一個選擇資料夾視窗開著，請先在那個視窗完成選擇。");
    } else if (result.outcome === "folder_pick_unavailable") {
      showToast("這台電腦無法開啟選擇資料夾視窗，請直接輸入路徑。", "danger");
    }
  } catch (error) {
    showToast(errorMessage(error, "無法開啟選擇資料夾視窗。"), "danger");
  } finally {
    pickingFolder.value = false;
  }
}

async function addProject(): Promise<boolean> {
  const { showToast } = useToast();
  if (!projectName.value.trim() || !projectRoot.value.trim()) {
    showToast("請填寫專案名稱與根目錄。", "danger");
    return false;
  }

  addingProject.value = true;
  try {
    await useApi().client.createProject({ name: projectName.value, rootPath: projectRoot.value });
    projectName.value = "";
    projectRoot.value = "";
    showToast("專案已加入 registry；目前仍是未註冊狀態。請明確切換為記錄中。", "success");
    await Promise.all([loadProjects(), loadDashboard()]);
    return true;
  } catch (error) {
    showToast(errorMessage(error, "加入專案失敗。"), "danger");
    return false;
  } finally {
    addingProject.value = false;
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
    const updated = await useApi().client.updateProject(project.id, { status });
    const index = projects.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) {
      projects.value[index] = updated;
    }
    showToast(`${updated.name}：${statusLabels[updated.status]}`, "success");
    await loadDashboard();
  } catch (error) {
    showToast(errorMessage(error, "更新專案狀態失敗。"), "danger");
  }
}

export function useProjects() {
  return {
    dashboard,
    projects,
    trackedProjects,
    recentSessions,
    projectName,
    projectRoot,
    addingProject,
    loadDashboard,
    loadProjects,
    addProject,
    pickingFolder,
    pickProjectFolder,
    updateProjectStatus,
  };
}

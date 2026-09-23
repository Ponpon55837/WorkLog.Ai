import { computed, ref } from "vue";
import type { DashboardSummary, ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import { statusLabels } from "../utils/labels";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useToast } from "./useToast";

const emptyDashboard: DashboardSummary = {
  trackedProjects: 0,
  activeProjects: 0,
  finalizedSessions: 0,
  recordedEvents: 0,
  recentSessions: []
};

const dashboard = ref<DashboardSummary>(emptyDashboard);
const projects = ref<ProjectRecord[]>([]);
const projectName = ref("");
const projectRoot = ref("");
const addingProject = ref(false);
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

async function addProject(): Promise<void> {
  const { showToast } = useToast();
  if (!projectName.value.trim() || !projectRoot.value.trim()) {
    showToast("請填寫專案名稱與根目錄。");
    return;
  }

  addingProject.value = true;
  try {
    await useApi().client.createProject({ name: projectName.value, rootPath: projectRoot.value });
    projectName.value = "";
    projectRoot.value = "";
    showToast("專案已加入 registry；目前仍是未註冊狀態。請明確切換為記錄中。");
    await Promise.all([loadProjects(), loadDashboard()]);
  } catch (error) {
    showToast(errorMessage(error, "加入專案失敗。"));
  } finally {
    addingProject.value = false;
  }
}

async function updateProjectStatus(project: ProjectRecord, status: ProjectStatus): Promise<void> {
  const { showToast } = useToast();
  try {
    const updated = await useApi().client.updateProject(project.id, { status });
    const index = projects.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) {
      projects.value[index] = updated;
    }
    showToast(`${updated.name}：${statusLabels[updated.status]}`);
    await loadDashboard();
  } catch (error) {
    showToast(errorMessage(error, "更新專案狀態失敗。"));
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
    updateProjectStatus
  };
}

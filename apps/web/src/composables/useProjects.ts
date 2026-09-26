import { storeToRefs } from "pinia";
import { useProjectsStore } from "../stores/projects";

/** Transitional composable adapter for project consumers migrating to the Pinia store. */
export function useProjects() {
  const store = useProjectsStore();
  const state = storeToRefs(store);
  return {
    ...state,
    loadDashboard: store.loadDashboard,
    loadProjects: store.loadProjects,
    loadProjectDeletionAudits: store.loadProjectDeletionAudits,
    pickProjectFolder: store.pickProjectFolder,
    addProject: store.addProject,
    updateProjectStatus: store.updateProjectStatus,
    deleteProject: store.deleteProject,
  };
}

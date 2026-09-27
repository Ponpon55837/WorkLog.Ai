import type {
  DeleteProjectResult,
  DashboardSummary,
  ProjectDeletionAuditRecord,
  ProjectRecord,
  ProjectListRecord,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectDataImportResult,
  ProjectStatus,
} from "@work-intelligence/core";
import { type ApiTransport } from "./transport";

export interface ProjectsApi {
  exportProjectData(scope: ProjectDataExportScope): Promise<{ blob: Blob; fileName: string }>;
  previewProjectDataImport(input: ProjectDataImportInput): Promise<ProjectDataImportPreview>;
  importProjectData(input: ProjectDataImportInput): Promise<ProjectDataImportResult>;
  getDashboard(signal?: AbortSignal): Promise<DashboardSummary>;
  listProjects(signal?: AbortSignal): Promise<ProjectListRecord[]>;
  listProjectDeletionAudits(signal?: AbortSignal): Promise<ProjectDeletionAuditRecord[]>;
  createProject(input: { name: string; rootPath: string }, signal?: AbortSignal): Promise<ProjectRecord>;
  updateProject(
    projectId: string,
    input: { name?: string; status?: ProjectStatus; repositoryUrl?: string | null },
    signal?: AbortSignal,
  ): Promise<ProjectRecord>;
  updateProjectLocation(
    projectId: string,
    input: { rootPath: string; confirmedTrackedScope: boolean },
    signal?: AbortSignal,
  ): Promise<ProjectRecord>;
  deleteProject(projectId: string, confirmationName: string, signal?: AbortSignal): Promise<DeleteProjectResult>;
}

export function createProjectsApi(client: ApiTransport): ProjectsApi {
  return {
    previewProjectDataImport(input: ProjectDataImportInput): Promise<ProjectDataImportPreview> {
      return client.write<ProjectDataImportPreview>("/api/import/preview", "POST", input);
    },

    importProjectData(input: ProjectDataImportInput): Promise<ProjectDataImportResult> {
      return client.write<ProjectDataImportResult>("/api/import", "POST", input);
    },

    getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
      return client.request<DashboardSummary>("/api/dashboard", { signal });
    },

    listProjects(signal?: AbortSignal): Promise<ProjectListRecord[]> {
      return client.request<ProjectListRecord[]>("/api/projects", { signal });
    },

    listProjectDeletionAudits(signal?: AbortSignal): Promise<ProjectDeletionAuditRecord[]> {
      return client.request<ProjectDeletionAuditRecord[]>("/api/project-deletion-audits", { signal });
    },

    createProject(input: { name: string; rootPath: string }, signal?: AbortSignal): Promise<ProjectRecord> {
      return client.write<ProjectRecord>("/api/projects", "POST", input, signal);
    },

    updateProject(
      projectId: string,
      input: { name?: string; status?: ProjectStatus; repositoryUrl?: string | null },
      signal?: AbortSignal,
    ): Promise<ProjectRecord> {
      return client.write<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}`, "PATCH", input, signal);
    },

    updateProjectLocation(
      projectId: string,
      input: { rootPath: string; confirmedTrackedScope: boolean },
      signal?: AbortSignal,
    ): Promise<ProjectRecord> {
      return client.write<ProjectRecord>(
        `/api/projects/${encodeURIComponent(projectId)}/location`,
        "PATCH",
        input,
        signal,
      );
    },

    deleteProject(projectId: string, confirmationName: string, signal?: AbortSignal): Promise<DeleteProjectResult> {
      return client.write<DeleteProjectResult>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        "DELETE",
        {
          confirmationName,
        },
        signal,
      );
    },

    async exportProjectData(scope: ProjectDataExportScope): Promise<{ blob: Blob; fileName: string }> {
      const body = scope.type === "all" ? { scope: "all" } : { scope: "project", projectId: scope.projectId };
      const blob = await client.download("/api/export", body, "無法匯出專案資料，請確認 API 是否已啟動。");
      const fileName =
        "work-intelligence-projects-" + new Date().toLocaleDateString("sv-SE").replace(/-/g, "") + ".json";
      return { blob, fileName };
    },
  };
}

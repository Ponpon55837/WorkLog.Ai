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
  ProjectDataImportStaged,
  ProjectDataImportStrategy,
  ProjectDataStagedImportOptions,
  ProjectStatus,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";
import { t } from "../i18n";

export interface ProjectsApi {
  exportProjectData(scope: ProjectDataExportScope): Promise<{ blob: Blob; fileName: string }>;
  previewProjectDataImport(input: ProjectDataImportInput): Promise<ProjectDataImportPreview>;
  importProjectData(input: ProjectDataImportInput): Promise<ProjectDataImportResult>;
  /** Streams the chosen file to the API as the raw request body; the renderer never reads or parses it. */
  stageProjectDataImport(
    file: File,
    strategy: ProjectDataImportStrategy,
    signal?: AbortSignal,
  ): Promise<ProjectDataImportStaged>;
  previewStagedProjectDataImport(
    stagingId: string,
    options: ProjectDataStagedImportOptions,
    signal?: AbortSignal,
  ): Promise<ProjectDataImportPreview>;
  importStagedProjectDataImport(
    stagingId: string,
    options: ProjectDataStagedImportOptions,
  ): Promise<ProjectDataImportResult>;
  /** `keepalive` lets the request outlive the page (used when the page is being left). */
  discardStagedProjectDataImport(stagingId: string, options?: { keepalive?: boolean }): Promise<void>;
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

function stagedPath(stagingId: string, suffix = ""): string {
  return `/api/import/staged/${encodeURIComponent(stagingId)}${suffix}`;
}

export function createProjectsApi(client: ApiTransport): ProjectsApi {
  return {
    previewProjectDataImport(input: ProjectDataImportInput): Promise<ProjectDataImportPreview> {
      return client.write<ProjectDataImportPreview>("/api/import/preview", "POST", input);
    },

    importProjectData(input: ProjectDataImportInput): Promise<ProjectDataImportResult> {
      return client.write<ProjectDataImportResult>("/api/import", "POST", input);
    },

    stageProjectDataImport(
      file: File,
      strategy: ProjectDataImportStrategy,
      signal?: AbortSignal,
    ): Promise<ProjectDataImportStaged> {
      // fetch streams a File body from disk, so a file far larger than memory-friendly JSON never enters the renderer.
      return client.request<ProjectDataImportStaged>(appendQuery("/api/import/staged", { strategy }), {
        method: "POST",
        body: file,
        signal,
      });
    },

    previewStagedProjectDataImport(
      stagingId: string,
      options: ProjectDataStagedImportOptions,
      signal?: AbortSignal,
    ): Promise<ProjectDataImportPreview> {
      return client.write<ProjectDataImportPreview>(stagedPath(stagingId, "/preview"), "POST", options, signal);
    },

    importStagedProjectDataImport(
      stagingId: string,
      options: ProjectDataStagedImportOptions,
    ): Promise<ProjectDataImportResult> {
      return client.write<ProjectDataImportResult>(stagedPath(stagingId), "POST", options);
    },

    async discardStagedProjectDataImport(stagingId: string, options?: { keepalive?: boolean }): Promise<void> {
      await client.send(stagedPath(stagingId), "DELETE", {}, undefined, options?.keepalive === true);
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
      const blob = await client.download("/api/export", body, t("api.couldNotExportProjectData"));
      const fileName =
        "work-intelligence-projects-" + new Date().toLocaleDateString("sv-SE").replace(/-/g, "") + ".json";
      return { blob, fileName };
    },
  };
}

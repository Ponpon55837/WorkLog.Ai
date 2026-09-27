import {
  createProjectInputSchema,
  deleteProjectInputSchema,
  updateProjectInputSchema,
  updateProjectLocationInputSchema,
} from "@work-intelligence/schema";
import { ProjectDeletionError, ProjectLocationError } from "@work-intelligence/storage";
import { inspectProjectFolder, readJsonBody, sendError, sendJson, withProjectFolderStatus } from "../http.js";
import { validatedRoute, type Route, type RouteContext } from "./router.js";

async function deleteProject({ store, request, response, params }: RouteContext): Promise<void> {
  const parsed = deleteProjectInputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "Invalid project deletion confirmation.",
      parsed.error.flatten(),
      "invalid_project_deletion_confirmation",
    );
    return;
  }
  try {
    sendJson(response, 200, store.deleteProject(params.projectId!, parsed.data.confirmationName));
  } catch (error) {
    if (!(error instanceof ProjectDeletionError)) {
      throw error;
    }
    switch (error.code) {
      case "PROJECT_NOT_FOUND":
        sendError(response, 404, "Project not found.", undefined, error.code);
        return;
      case "PROJECT_NAME_MISMATCH":
        sendError(response, 409, "The confirmation name does not match the project name.", undefined, error.code);
        return;
      case "PROJECT_BACKUP_FAILED":
        sendError(
          response,
          503,
          "The required pre-deletion backup could not be created; the project was not deleted.",
          undefined,
          error.code,
        );
        return;
      case "PROJECT_DELETE_FAILED":
        sendError(
          response,
          500,
          "Project deletion failed; the pre-deletion backup is preserved.",
          undefined,
          error.code,
        );
        return;
    }
  }
}

async function updateLocation({ store, request, response, params }: RouteContext): Promise<void> {
  const parsed = updateProjectLocationInputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    sendError(response, 400, "重新指定專案位置的資料無效。", parsed.error.flatten(), "project_location_invalid");
    return;
  }
  if (inspectProjectFolder(parsed.data.rootPath) !== "found") {
    sendError(response, 400, "選擇的位置不是可用的資料夾。", undefined, "project_location_invalid");
    return;
  }
  try {
    sendJson(
      response,
      200,
      store.updateProjectLocation(params.projectId!, parsed.data.rootPath, parsed.data.confirmedTrackedScope),
    );
  } catch (error) {
    if (!(error instanceof ProjectLocationError)) throw error;
    if (error.code === "project_not_found") {
      sendError(response, 404, "找不到指定專案。", undefined, error.code);
    } else if (error.code === "project_location_confirmation_required") {
      sendError(response, 409, "記錄中的專案需要先確認擴大 Agent 可讀取的範圍。", undefined, error.code);
    } else {
      sendError(response, 409, "新資料夾與其他專案的根目錄重疊。", undefined, error.code);
    }
  }
}

async function updateProject({ store, request, response, params }: RouteContext): Promise<void> {
  const parsed = updateProjectInputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    sendError(response, 400, "Invalid project update payload.", parsed.error.flatten());
    return;
  }
  const project = store.updateProject(params.projectId!, parsed.data);
  if (!project) {
    sendError(response, 404, "Project not found.");
    return;
  }
  sendJson(response, 200, project);
}

export const projectRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/projects",
    handler: ({ store, response }) => sendJson(response, 200, store.listProjects().map(withProjectFolderStatus)),
  },
  {
    method: "GET",
    pattern: "/api/project-deletion-audits",
    handler: ({ store, response }) => sendJson(response, 200, store.listProjectDeletionAudits()),
  },
  {
    method: "POST",
    pattern: "/api/projects",
    handler: validatedRoute(
      createProjectInputSchema,
      "Invalid project payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.addProject(data.name, data.rootPath),
      201,
    ),
  },
  { method: "DELETE", pattern: "/api/projects/:projectId", handler: deleteProject },
  { method: "PATCH", pattern: "/api/projects/:projectId/location", handler: updateLocation },
  { method: "PATCH", pattern: "/api/projects/:projectId", handler: updateProject },
];

import type { ServerResponse } from "node:http";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  DatabaseBackup,
  ProjectDataExportScope,
  ProjectDataImportInput,
  SystemStatus,
} from "@work-intelligence/core";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import {
  databaseBackupFileNameSchema,
  deleteDatabaseBackupBodySchema,
  projectDataExportRequestSchema,
  projectDataImportInputSchema,
} from "@work-intelligence/schema";
import { LATEST_SCHEMA_VERSION, type WorkIntelligenceStore } from "@work-intelligence/storage";
import { inspectDatabaseReadOnlyMetadata } from "../database-inspection.js";
import {
  MAX_PROJECT_IMPORT_BYTES,
  inspectProjectFolder,
  readJsonBody,
  sendError,
  sendJson,
  sendProjectDataTransferError,
} from "../http.js";
import type { Route, RouteContext } from "./router.js";

/** Streams a fresh snapshot of the whole database as a download and removes the temporary copy. */
async function sendDatabaseExport(store: WorkIntelligenceStore, response: ServerResponse): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-export-"));
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
    const fileName = `work-intelligence-export-${stamp}.sqlite`;
    const target = join(directory, fileName);
    const { bytes } = store.exportTo(target);
    response.writeHead(200, {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(bytes),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(createReadStream(target), response);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sendProjectDataExport(
  store: WorkIntelligenceStore,
  scope: ProjectDataExportScope,
  response: ServerResponse,
): void {
  const content = JSON.stringify(store.exportProjectData(scope));
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_PROJECT_IMPORT_BYTES) {
    sendError(response, 413, "這份專案匯出檔超過 50 MiB，請改用整份 SQLite 快照。");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fileName = `work-intelligence-projects-${stamp}.json`;
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes),
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

/** Parses a project import body, sending the validation error itself when it is invalid. */
async function readImportInput({ request, response }: RouteContext): Promise<ProjectDataImportInput | undefined> {
  const parsed = projectDataImportInputSchema.safeParse(await readJsonBody(request, MAX_PROJECT_IMPORT_BYTES));
  if (!parsed.success) {
    sendError(response, 400, `匯入檔格式錯誤：${parsed.error.issues[0]?.message ?? "欄位驗證失敗。"}`);
    return undefined;
  }
  return parsed.data satisfies ProjectDataImportInput;
}

async function systemStatus({ store, response, services }: RouteContext): Promise<void> {
  const database =
    store.databasePath === ":memory:"
      ? { state: "ok" as const, schemaVersion: LATEST_SCHEMA_VERSION }
      : await inspectDatabaseReadOnlyMetadata(store.databasePath);
  let backupSnapshot: { available: boolean; backups: DatabaseBackup[] } = { available: false, backups: [] };
  try {
    const result = store.listBackups();
    if (result.outcome === "database_backups") {
      backupSnapshot = { available: true, backups: result.backups };
    }
  } catch {
    // Report backup metrics as unavailable without exposing filesystem details.
  }
  const automaticBackup = backupSnapshot.backups.find((backup) => backup.kind === "automatic") ?? null;
  const status: SystemStatus = {
    version: APP_VERSION,
    schemaVersion: LATEST_SCHEMA_VERSION,
    database: {
      path: store.databasePath,
      bytes: database.bytes ?? null,
      state: database.state,
      schemaVersion: database.schemaVersion ?? null,
    },
    backups: {
      available: backupSnapshot.available,
      latestAutomatic: automaticBackup,
      count: backupSnapshot.backups.length,
      totalBytes: backupSnapshot.backups.reduce((total, backup) => total + backup.bytes, 0),
    },
    maintenance: database.maintenance ?? null,
    mcp: services.mcpRuntimeStatus(),
    agents: services.agentConnections(),
    sseConnections: services.eventClientCount(),
  };
  sendJson(response, 200, status);
}

async function deleteBackup({ store, request, response, params }: RouteContext): Promise<void> {
  // JSON-only requests keep cross-site forms from triggering destructive actions.
  const body = await readJsonBody(request);
  if (!deleteDatabaseBackupBodySchema.safeParse(body).success) {
    sendError(response, 400, "刪除備份請求無效。");
    return;
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(params.fileName!);
  } catch {
    sendError(response, 400, "備份檔名無效。");
    return;
  }
  const parsedFileName = databaseBackupFileNameSchema.safeParse(fileName);
  if (!parsedFileName.success) {
    sendError(response, 400, "備份檔名無效。");
    return;
  }

  const result = store.deleteBackup(parsedFileName.data);
  if (result.outcome === "backup_deleted") {
    sendJson(response, 200, result);
  } else if (result.outcome === "backup_not_found") {
    sendError(response, 404, "找不到這份備份。");
  } else if (result.outcome === "invalid_backup_file_name") {
    sendError(response, 400, "備份檔名無效。");
  } else {
    sendError(response, 409, result.reason, undefined, "backup_unavailable");
  }
}

async function exportData({ store, request, response }: RouteContext): Promise<void> {
  const body = await readJsonBody(request);
  if (typeof body === "object" && body !== null && Object.keys(body).length === 0) {
    await sendDatabaseExport(store, response);
    return;
  }
  const parsed = projectDataExportRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendError(response, 400, "匯出範圍無效。", parsed.error.flatten());
    return;
  }
  const scope: ProjectDataExportScope =
    parsed.data.scope === "all" ? { type: "all" } : { type: "project", projectId: parsed.data.projectId ?? "" };
  try {
    sendProjectDataExport(store, scope, response);
  } catch (error) {
    if (!sendProjectDataTransferError(response, error)) throw error;
  }
}

async function previewImport(context: RouteContext): Promise<void> {
  const input = await readImportInput(context);
  if (!input) return;
  try {
    const preview = context.store.previewProjectDataImport(input);
    sendJson(context.response, 200, {
      ...preview,
      selectedProjects: preview.selectedProjects.map((project) => ({
        ...project,
        folderStatus: inspectProjectFolder(project.rootPath),
      })),
    });
  } catch (error) {
    if (!sendProjectDataTransferError(context.response, error)) throw error;
  }
}

async function importData(context: RouteContext): Promise<void> {
  const input = await readImportInput(context);
  if (!input) return;
  try {
    sendJson(context.response, 200, context.store.importProjectData(input));
  } catch (error) {
    if (!sendProjectDataTransferError(context.response, error)) throw error;
  }
}

export const systemRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    handler: ({ store, response }) => {
      let databaseHealthy = true;
      try {
        store.listProjects();
      } catch {
        databaseHealthy = false;
      }
      sendJson(response, databaseHealthy ? 200 : 503, {
        ok: true,
        app: "Work Intelligence",
        version: APP_VERSION,
        schemaVersion: LATEST_SCHEMA_VERSION,
        policy: "explicit-opt-in/default-deny",
        database: databaseHealthy ? "connected" : "unavailable",
      });
    },
  },
  { method: "GET", pattern: "/api/system/status", handler: systemStatus },
  { method: "GET", pattern: "/api/events", handler: ({ response, services }) => services.startEventStream(response) },
  {
    method: "POST",
    pattern: "/api/system/pick-folder",
    handler: async ({ request, response, services }) => {
      // JSON-only like every POST, so a cross-site form cannot pop a dialog on the user's screen.
      await readJsonBody(request);
      sendJson(response, 200, await services.pickFolder());
    },
  },
  {
    method: "GET",
    pattern: "/api/backups",
    handler: ({ store, response }) => {
      const result = store.listBackups();
      if (result.outcome === "backup_unavailable") {
        sendJson(response, 409, { ...result, error: result.reason, code: "backup_unavailable" });
      } else {
        sendJson(response, 200, result);
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/backups",
    handler: async ({ store, request, response }) => {
      // Requiring a JSON body keeps cross-site form posts from triggering backups.
      await readJsonBody(request);
      const result = store.createBackup();
      if (result.outcome === "backup_unavailable") {
        sendJson(response, 409, { ...result, error: result.reason, code: "backup_unavailable" });
      } else {
        sendJson(response, 201, result);
      }
    },
  },
  { method: "DELETE", pattern: "/api/backups/:fileName*", handler: deleteBackup },
  { method: "POST", pattern: "/api/export", handler: exportData },
  { method: "POST", pattern: "/api/import/preview", handler: previewImport },
  { method: "POST", pattern: "/api/import", handler: importData },
];

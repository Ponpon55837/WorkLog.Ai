import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DatabaseBackup, ProjectDataExportScope, SystemStatus } from "@work-intelligence/core";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { INSTANCE_PROOF_HEADER } from "@work-intelligence/shared/instance-proof";
import {
  databaseBackupFileNameSchema,
  deleteDatabaseBackupBodySchema,
  projectDataExportRequestSchema,
} from "@work-intelligence/schema";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import { inspectDatabaseReadOnlyMetadata } from "../database-inspection.js";
import {
  MAX_PROJECT_IMPORT_BYTES,
  PROJECT_EXPORT_TOO_LARGE_MESSAGE,
  readJsonBody,
  receiveJsonBodyFile,
  sendError,
  sendJson,
  sendProjectDataTransferError,
} from "../http.js";
import { getSqliteRuntimeStatus } from "../sqlite-runtime.js";
import { createTransferDirectory, removeTransferDirectory } from "../transfer-workspace.js";
import { parseRequestInput, type ProjectDataImportUpload, type Route, type RouteContext } from "./router.js";

/** Read size for streaming a database export: large reads cut the per-chunk overhead of a file of tens of MB. */
const EXPORT_READ_CHUNK_BYTES = 1024 * 1024;

/** Streams a fresh snapshot of the whole database as a download and removes the temporary copy. */
async function sendDatabaseExport(services: RouteContext["services"], response: ServerResponse): Promise<void> {
  const { backgroundStore } = services;
  const directory = createTransferDirectory(services.transferRoot, "export");
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
    const fileName = `work-intelligence-export-${stamp}.sqlite`;
    const target = join(directory, fileName);
    // A staging copy, streamed once and removed below: nothing needs it on disk after a crash, so skip the fsyncs.
    const { bytes } = await backgroundStore.exportTo(target, { durable: false });
    response.writeHead(200, {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(bytes),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    // 1 MiB reads: a 25 MB snapshot in ~25 chunks instead of ~400, which shortens and steadies the transfer.
    await pipeline(createReadStream(target, { highWaterMark: EXPORT_READ_CHUNK_BYTES }), response);
  } finally {
    removeTransferDirectory(directory);
  }
}

/** Writes the portable export to a transfer file in the background process and streams it as a download. */
async function sendProjectDataExport(
  services: RouteContext["services"],
  scope: ProjectDataExportScope,
  response: ServerResponse,
): Promise<void> {
  const directory = createTransferDirectory(services.transferRoot, "export");
  try {
    const target = join(directory, "export.json");
    const { bytes } = await services.backgroundStore.exportProjectData(scope, target);
    if (bytes > MAX_PROJECT_IMPORT_BYTES) {
      // A file this size could not be imported again, so a whole-database snapshot is the way to move it.
      sendError(response, 413, PROJECT_EXPORT_TOO_LARGE_MESSAGE);
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
    await pipeline(createReadStream(target, { highWaterMark: EXPORT_READ_CHUNK_BYTES }), response);
  } finally {
    removeTransferDirectory(directory);
  }
}

/**
 * Saves the import request body to a transfer directory and hands it to `operation`, which streams it in the
 * background process; the directory (body and spill file) is removed afterwards, whatever happens.
 */
async function withImportUpload<T>(
  context: RouteContext,
  operation: (upload: ProjectDataImportUpload) => Promise<T>,
): Promise<T> {
  const directory = createTransferDirectory(context.services.transferRoot, "import");
  try {
    const path = join(directory, "import.json");
    await receiveJsonBodyFile(context.request, path, MAX_PROJECT_IMPORT_BYTES);
    return await operation({ path, directory });
  } finally {
    removeTransferDirectory(directory);
  }
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
    userService: await services.userServiceStatus(),
    mcp: services.mcpRuntimeStatus(),
    agents: services.agentConnections(),
    sseConnections: services.eventClientCount(),
    sqlite: getSqliteRuntimeStatus(),
  };
  sendJson(response, 200, status);
}

async function deleteBackup({ store, request, response, params }: RouteContext): Promise<void> {
  // JSON-only requests keep cross-site forms from triggering destructive actions.
  const body = await readJsonBody(request);
  const parsedBody = parseRequestInput(deleteDatabaseBackupBodySchema, body);
  if (!parsedBody.success) {
    sendError(response, 400, "刪除備份請求無效。", parsedBody.error.flatten());
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

async function exportData({ request, response, services }: RouteContext): Promise<void> {
  const body = await readJsonBody(request);
  if (typeof body === "object" && body !== null && Object.keys(body).length === 0) {
    await sendDatabaseExport(services, response);
    return;
  }
  const parsed = parseRequestInput(projectDataExportRequestSchema, body);
  if (!parsed.success) {
    sendError(response, 400, "匯出範圍無效。", parsed.error.flatten());
    return;
  }
  const scope: ProjectDataExportScope =
    parsed.data.scope === "all" ? { type: "all" } : { type: "project", projectId: parsed.data.projectId ?? "" };
  try {
    await sendProjectDataExport(services, scope, response);
  } catch (error) {
    if (!sendProjectDataTransferError(response, error)) throw error;
  }
}

async function previewImport(context: RouteContext): Promise<void> {
  try {
    const preview = await withImportUpload(context, (upload) =>
      context.services.backgroundStore.previewProjectDataImport(upload),
    );
    sendJson(context.response, 200, preview);
  } catch (error) {
    if (!sendProjectDataTransferError(context.response, error)) throw error;
  }
}

/** The body goes to disk and then to the background process, which validates, backs up and imports it. */
async function importData(context: RouteContext): Promise<void> {
  try {
    const result = await withImportUpload(context, (upload) =>
      context.services.backgroundStore.importProjectData(upload),
    );
    sendJson(context.response, 200, result);
  } catch (error) {
    if (!sendProjectDataTransferError(context.response, error)) throw error;
  }
}

export const systemRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/health",
    handler: ({ store, request, response, services }) => {
      let databaseHealthy = true;
      try {
        store.listProjects();
      } catch {
        databaseHealthy = false;
      }
      const proof = services.instanceProof(request);
      if (proof) response.setHeader(INSTANCE_PROOF_HEADER, proof);
      sendJson(response, databaseHealthy ? 200 : 503, {
        ok: databaseHealthy,
        app: "Work Intelligence",
        version: APP_VERSION,
        schemaVersion: LATEST_SCHEMA_VERSION,
        policy: "explicit-opt-in/default-deny",
        database: databaseHealthy ? "connected" : "unavailable",
        sqlite: getSqliteRuntimeStatus(),
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
    handler: async ({ request, response, services }) => {
      // Requiring a JSON body keeps cross-site form posts from triggering backups.
      await readJsonBody(request);
      const result = await services.backgroundStore.createBackup();
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

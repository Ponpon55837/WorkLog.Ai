import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { createWriteStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ApiErrorCode,
  ProjectDataImportPreview,
  ProjectDataImportResult,
  ProjectFolderStatus,
  ProjectListRecord,
} from "@work-intelligence/core";
import {
  ProjectDataImportSyntaxError,
  ProjectDataTransferError,
  readProjectDataImportFile,
  type ValidatedProjectDataImport,
  type WorkIntelligenceStore,
  canonicalizeProjectRoot,
  hydrateRow,
} from "@work-intelligence/storage";
import type {
  ProjectDataImportPreviewWithFolderStatus,
  ProjectDataImportUpload,
  StagedProjectDataImportInspection,
} from "./routes/router.js";
import { hasTransferSpace, TRANSFER_DISK_FULL_MESSAGE } from "./transfer-workspace.js";

/** @internal test-only */
export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;
// Import, preview and export stream the file in bounded memory, so this limit is about disk and time, not heap.
export const MAX_PROJECT_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_PROJECT_IMPORT_MIB = MAX_PROJECT_IMPORT_BYTES / 1024 / 1024;
export const PROJECT_IMPORT_TOO_LARGE_MESSAGE = `匯入檔不可超過 ${MAX_PROJECT_IMPORT_MIB} MiB。`;
export const PROJECT_EXPORT_TOO_LARGE_MESSAGE = `這份專案匯出檔超過 ${MAX_PROJECT_IMPORT_MIB} MiB，請改用整份 SQLite 快照。`;

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

export class RequestBodyError extends Error {
  public constructor(
    public readonly statusCode: 400 | 413 | 415 | 507,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

function defaultApiErrorCode(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return "invalid_input";
    case 403:
      return "origin_not_allowed";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 421:
      return "host_not_allowed";
    case 503:
      return "service_unavailable";
    case 507:
      return "database_disk_full";
    default:
      return "internal_error";
  }
}

function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestBodyError(415, "Content-Type must be application/json.");
  }
}

export async function readJsonBody(request: IncomingMessage, maxBytes = MAX_INPUT_PAYLOAD_BYTES): Promise<unknown> {
  assertJsonContentType(request);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new RequestBodyError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body.");
  }
}

export async function receiveJsonBodyFile(request: IncomingMessage, target: string, maxBytes: number): Promise<number> {
  assertJsonContentType(request);
  const declared = Number(request.headers["content-length"]);
  const known = Number.isSafeInteger(declared) && declared >= 0;
  if (known && declared > maxBytes) throw new RequestBodyError(413, "Request body is too large.");
  if (!(await hasTransferSpace(dirname(target), known ? declared : maxBytes))) {
    throw new RequestBodyError(507, TRANSFER_DISK_FULL_MESSAGE);
  }
  let total = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) callback(new RequestBodyError(413, "Request body is too large."));
      else callback(null, chunk);
    },
  });
  await pipeline(request, limit, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  return total;
}

/** @internal test-only */
export function validateProjectDataImportUpload(upload: ProjectDataImportUpload): ValidatedProjectDataImport {
  const envelope = upload.envelope ?? "request";
  let validated: ValidatedProjectDataImport;
  try {
    validated = readProjectDataImportFile(upload.path, {
      envelope,
      spillPath: join(upload.directory, `import-${randomUUID()}.spill`),
    });
  } catch (error) {
    if (error instanceof ProjectDataImportSyntaxError) {
      throw new RequestBodyError(error.kind === "invalid_json" ? 400 : 413, error.message);
    }
    throw error;
  }
  if (envelope === "request") return validated;
  try {
    return validated.withOptions(upload.options ?? {});
  } catch (error) {
    validated.dispose();
    throw error;
  }
}

function withFolderStatus(preview: ProjectDataImportPreview): ProjectDataImportPreviewWithFolderStatus {
  return {
    ...preview,
    selectedProjects: preview.selectedProjects.map((project) => ({
      ...project,
      folderStatus: inspectProjectFolder(project.rootPath),
    })),
  };
}

export function previewProjectDataImportUpload(
  store: WorkIntelligenceStore,
  upload: ProjectDataImportUpload,
): ProjectDataImportPreviewWithFolderStatus {
  const validated = validateProjectDataImportUpload(upload);
  try {
    return withFolderStatus(store.previewProjectDataImport(validated));
  } finally {
    validated.dispose();
  }
}

export function inspectStagedProjectDataImport(
  store: WorkIntelligenceStore,
  upload: ProjectDataImportUpload,
): StagedProjectDataImportInspection {
  const validated = validateProjectDataImportUpload({ ...upload, envelope: "bundle" });
  try {
    const { bundle } = validated.input;
    return {
      header: {
        schemaVersion: bundle.schemaVersion,
        exportedAt: bundle.exportedAt,
        scope: bundle.scope,
        projects: bundle.tables.projects.map((row) => {
          const project = hydrateRow(row);
          return { id: String(project.id), name: String(project.name) };
        }),
      },
      preview: withFolderStatus(store.previewProjectDataImport(validated)),
    };
  } finally {
    validated.dispose();
  }
}

export function importProjectDataUpload(
  store: WorkIntelligenceStore,
  upload: ProjectDataImportUpload,
): ProjectDataImportResult {
  const validated = validateProjectDataImportUpload(upload);
  try {
    return store.importProjectData(validated);
  } finally {
    validated.dispose();
  }
}

export async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  return (await readJsonBody(request)) as Record<string, unknown>;
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  details?: unknown,
  code: ApiErrorCode = defaultApiErrorCode(statusCode),
): void {
  sendJson(response, statusCode, { error: message, code, details });
}

export function sendProjectDataTransferError(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ProjectDataTransferError)) {
    return false;
  }
  switch (error.code) {
    case "project_not_found":
      sendError(response, 404, error.message, undefined, error.code);
      return true;
    case "invalid_input":
    case "invalid_bundle":
    case "unsupported_schema":
      sendError(response, 400, error.message, undefined, error.code);
      return true;
    case "export_too_large":
      sendError(response, 413, PROJECT_EXPORT_TOO_LARGE_MESSAGE, undefined, "payload_too_large");
      return true;
    case "project_backup_failed":
      sendError(
        response,
        503,
        "The required pre-import backup could not be created; nothing was imported.",
        undefined,
        error.code,
      );
      return true;
  }
}

export function inspectProjectFolder(rootPath: string): ProjectFolderStatus {
  if (!isAbsolute(rootPath) || rootPath.includes("\0")) {
    return "missing";
  }
  try {
    return statSync(canonicalizeProjectRoot(rootPath)).isDirectory() ? "found" : "missing";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

export function withProjectFolderStatus(
  project: ProjectListRecord | Omit<ProjectListRecord, "folderStatus">,
): ProjectListRecord {
  return { ...project, folderStatus: inspectProjectFolder(project.rootPath) };
}

export function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value ? Number(value) : undefined;
}

export function textParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name)?.trim() || undefined;
}

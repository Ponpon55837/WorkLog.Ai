import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";
import type {
  DatabaseBackup,
  FolderPickResult,
  ProjectDataExportScope,
  ProjectDataImportInput,
  SystemStatus,
} from "@work-intelligence/core";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import {
  attachEvidenceInputSchema,
  cancelMetadataBackfillRequestInputSchema,
  cancelReportSynthesisRequestInputSchema,
  createReportSynthesisRequestInputSchema,
  createProjectInputSchema,
  finalizeSessionInputSchema,
  databaseBackupFileNameSchema,
  deleteDatabaseBackupBodySchema,
  graphQuerySchema,
  handoffImportApplyInputSchema,
  handoffImportOptionsSchema,
  knowledgeHistoryQuerySchema,
  knowledgeQuerySchema,
  metadataBackfillApplyInputSchema,
  createMetadataBackfillRequestInputSchema,
  metadataBackfillRequestContextQuerySchema,
  metadataBackfillRequestQuerySchema,
  metadataBackfillPreviewQuerySchema,
  reportExportQuerySchema,
  reportSynthesisContextQuerySchema,
  reportSynthesisRequestQuerySchema,
  retryReportSynthesisRequestInputSchema,
  reportQuerySchema,
  recordKnowledgeInputSchema,
  saveReportSummaryInputSchema,
  searchQuerySchema,
  sessionsQuerySchema,
  setEvidenceVoidInputSchema,
  setSessionVoidInputSchema,
  linkSessionsInputSchema,
  decideKnowledgeCandidateInputSchema,
  deleteProjectInputSchema,
  knowledgeCandidateListQuerySchema,
  requestKnowledgeCandidatesInputSchema,
  updateSessionVerificationInputSchema,
  updateProjectInputSchema,
  updateKnowledgeInputSchema,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema,
  updateSessionWorkSummaryInputSchema,
  projectDataExportRequestSchema,
  projectDataImportInputSchema,
} from "@work-intelligence/schema";
import {
  DATABASE_BUSY_MESSAGE,
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  ProjectDeletionError,
  WorkIntelligenceStore,
  isDatabaseBusyError,
} from "@work-intelligence/storage";
import { createFolderPicker } from "./folder-picker.js";
import { inspectDatabaseReadOnlyMetadata } from "./database-inspection.js";
import { applyProductionSecurityHeaders, createStaticFilesHandler } from "./static-files.js";

const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;
const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_EVENT_CLIENTS = 32;
const EVENT_HEARTBEAT_INTERVAL_MS = 15_000;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

const defaultAllowedOrigins = process.env.WORK_INTELLIGENCE_WEB_DIST
  ? ""
  : "http://127.0.0.1:5966,http://localhost:5966";
const allowedOrigins = new Set(
  (process.env.WORK_INTELLIGENCE_ALLOWED_ORIGINS ?? defaultAllowedOrigins)
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*"),
);

if ((process.env.WORK_INTELLIGENCE_ALLOWED_ORIGINS ?? "").split(",").some((origin) => origin.trim() === "*")) {
  console.error(
    "[work-intelligence] WORK_INTELLIGENCE_ALLOWED_ORIGINS=* is not allowed; using the explicit origin allowlist instead.",
  );
}

// DNS rebinding guard: a rebound page is same-origin, so its GETs carry no Origin header, but the
// Host header still names the attacker's domain. Only loopback names and allowlisted origins pass.
const allowedHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
for (const origin of allowedOrigins) {
  try {
    allowedHostnames.add(new URL(origin).hostname);
  } catch {
    // An unparsable origin cannot match a browser Origin header either; ignore it here.
  }
}

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  try {
    return allowedHostnames.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

class RequestBodyError extends Error {
  public constructor(
    public readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin || isSameOrigin(request, origin) || !allowedOrigins.has(origin)) {
    return;
  }

  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
}

function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  if (!request.headers.host) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(`http://${request.headers.host}`).origin;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes = MAX_INPUT_PAYLOAD_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestBodyError(415, "Content-Type must be application/json.");
  }

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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, statusCode: number, message: string, details?: unknown): void {
  sendJson(response, statusCode, { error: message, details });
}

function sendProjectDataTransferError(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ProjectDataTransferError)) {
    return false;
  }
  switch (error.code) {
    case "project_not_found":
      sendError(response, 404, error.message);
      return true;
    case "invalid_input":
    case "invalid_bundle":
    case "unsupported_schema":
      sendError(response, 400, error.message);
      return true;
  }
}

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

export interface ApiHandlerOptions {
  /** Shows the native folder dialog; injectable so tests never open a real window. */
  pickFolder?: () => Promise<FolderPickResult>;
  /** Polling interval for the SQLite change stream; configurable to keep integration tests fast. */
  eventPollIntervalMs?: number;
  /** Maximum number of simultaneous SSE clients. */
  maxEventClients?: number;
  /** Serves a built Web distribution on the same origin as this API server. */
  webDirectory?: string;
}

export type ApiHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
  closeEventStreams: () => void;
};

export function createApiHandler(store: WorkIntelligenceStore, options: ApiHandlerOptions = {}): ApiHandler {
  const pickFolder = options.pickFolder ?? createFolderPicker();
  const serveWebFiles = options.webDirectory ? createStaticFilesHandler(options.webDirectory) : undefined;
  const eventClients = new Set<ServerResponse>();
  const eventPollIntervalMs = Math.max(1, options.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS);
  const requestedMaxEventClients = options.maxEventClients ?? DEFAULT_MAX_EVENT_CLIENTS;
  const maxEventClients = Number.isFinite(requestedMaxEventClients)
    ? Math.max(1, Math.trunc(requestedMaxEventClients))
    : DEFAULT_MAX_EVENT_CLIENTS;
  let lastChangeToken = store.getChangeToken();
  let lastHeartbeatAt = Date.now();
  let eventPollTimer: ReturnType<typeof setInterval> | undefined;

  function stopEventPolling(): void {
    if (eventPollTimer) {
      clearInterval(eventPollTimer);
      eventPollTimer = undefined;
    }
  }

  function publishChanged(): void {
    for (const client of eventClients) {
      if (client.destroyed || client.writableEnded) {
        eventClients.delete(client);
        continue;
      }
      try {
        // This event is deliberately data-free; the browser must refetch through the normal API.
        client.write("event: changed\ndata:\n\n");
      } catch {
        eventClients.delete(client);
      }
    }
    lastHeartbeatAt = Date.now();
  }

  function pollDatabaseChanges(): void {
    try {
      const changeToken = store.getChangeToken();
      if (changeToken !== lastChangeToken) {
        lastChangeToken = changeToken;
        publishChanged();
        return;
      }
    } catch {
      // Keep the stream open and retry on the next interval if SQLite is temporarily unavailable.
      return;
    }

    if (Date.now() - lastHeartbeatAt >= EVENT_HEARTBEAT_INTERVAL_MS) {
      for (const client of eventClients) {
        if (!client.destroyed && !client.writableEnded) {
          client.write(": keep-alive\n\n");
        }
      }
      lastHeartbeatAt = Date.now();
    }
  }

  function startEventStream(response: ServerResponse): void {
    if (eventClients.size >= maxEventClients) {
      response.setHeader("Retry-After", "5");
      sendError(response, 503, "SSE connection limit reached.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    response.once("close", () => {
      eventClients.delete(response);
      if (eventClients.size === 0) {
        stopEventPolling();
      }
    });

    if (!eventPollTimer) {
      lastChangeToken = store.getChangeToken();
      lastHeartbeatAt = Date.now();
      eventPollTimer = setInterval(pollDatabaseChanges, eventPollIntervalMs);
      eventPollTimer.unref();
    }
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (serveWebFiles) {
      applyProductionSecurityHeaders(response);
    }
    if (!isAllowedHost(request.headers.host)) {
      sendError(response, 421, "Host is not allowed.");
      return;
    }

    applyCorsHeaders(request, response);

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin) && !isSameOrigin(request, origin)) {
      sendError(response, 403, "Origin is not allowed.");
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, JSON_HEADERS);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathParts = requestUrl.pathname.split("/").filter(Boolean);

    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
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
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/system/status") {
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
          sseConnections: eventClients.size,
        };
        sendJson(response, 200, status);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/events") {
        startEventStream(response);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/system/pick-folder") {
        // JSON-only like every POST, so a cross-site form cannot pop a dialog on the user's screen.
        await readJsonBody(request);
        sendJson(response, 200, await pickFolder());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/backups") {
        const result = store.listBackups();
        sendJson(response, result.outcome === "database_backups" ? 200 : 409, result);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/backups") {
        // Requiring a JSON body keeps cross-site form posts from triggering backups.
        await readJsonBody(request);
        const result = store.createBackup();
        sendJson(response, result.outcome === "database_backups" ? 201 : 409, result);
        return;
      }

      if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/backups/")) {
        // JSON-only requests keep cross-site forms from triggering destructive actions.
        const body = await readJsonBody(request);
        if (!deleteDatabaseBackupBodySchema.safeParse(body).success) {
          sendError(response, 400, "刪除備份請求無效。");
          return;
        }
        const encodedFileName = requestUrl.pathname.slice("/api/backups/".length);
        let fileName: string;
        try {
          fileName = decodeURIComponent(encodedFileName);
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
          sendError(response, 409, result.reason);
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/export") {
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
          if (sendProjectDataTransferError(response, error)) {
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/import/preview") {
        const body = await readJsonBody(request, MAX_PROJECT_IMPORT_BYTES);
        const parsed = projectDataImportInputSchema.safeParse(body);
        if (!parsed.success) {
          sendError(response, 400, `匯入檔格式錯誤：${parsed.error.issues[0]?.message ?? "欄位驗證失敗。"}`);
          return;
        }
        const input = parsed.data satisfies ProjectDataImportInput;
        try {
          const preview = store.previewProjectDataImport(input);
          sendJson(response, 200, preview);
        } catch (error) {
          if (sendProjectDataTransferError(response, error)) {
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/import") {
        const body = await readJsonBody(request, MAX_PROJECT_IMPORT_BYTES);
        const parsed = projectDataImportInputSchema.safeParse(body);
        if (!parsed.success) {
          sendError(response, 400, `匯入檔格式錯誤：${parsed.error.issues[0]?.message ?? "欄位驗證失敗。"}`);
          return;
        }
        const input = parsed.data satisfies ProjectDataImportInput;
        try {
          const result = store.importProjectData(input);
          sendJson(response, 200, result);
        } catch (error) {
          if (sendProjectDataTransferError(response, error)) {
            return;
          }
          throw error;
        }
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/dashboard") {
        sendJson(response, 200, store.getDashboardSummary());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/reports") {
        const parsed = reportQuerySchema.safeParse({
          period: requestUrl.searchParams.get("period") ?? undefined,
          date: requestUrl.searchParams.get("date") ?? undefined,
          from: requestUrl.searchParams.get("from") ?? undefined,
          to: requestUrl.searchParams.get("to") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          evidenceKind: requestUrl.searchParams.get("evidenceKind") ?? undefined,
          evidenceQuery: requestUrl.searchParams.get("evidenceQuery")?.trim() || undefined,
          evidencePage: requestUrl.searchParams.get("evidencePage")
            ? Number(requestUrl.searchParams.get("evidencePage"))
            : undefined,
          evidencePageSize: requestUrl.searchParams.get("evidencePageSize")
            ? Number(requestUrl.searchParams.get("evidencePageSize"))
            : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.getReport(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/reports/export") {
        const parsed = reportExportQuerySchema.safeParse({
          period: requestUrl.searchParams.get("period") ?? undefined,
          date: requestUrl.searchParams.get("date") ?? undefined,
          from: requestUrl.searchParams.get("from") ?? undefined,
          to: requestUrl.searchParams.get("to") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          evidenceKind: requestUrl.searchParams.get("evidenceKind") ?? undefined,
          evidenceQuery: requestUrl.searchParams.get("evidenceQuery")?.trim() || undefined,
          evidencePage: requestUrl.searchParams.get("evidencePage")
            ? Number(requestUrl.searchParams.get("evidencePage"))
            : undefined,
          evidencePageSize: requestUrl.searchParams.get("evidencePageSize")
            ? Number(requestUrl.searchParams.get("evidencePageSize"))
            : undefined,
          format: requestUrl.searchParams.get("format") ?? undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report export query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.exportReport(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/reports/synthesis-requests") {
        const parsed = createReportSynthesisRequestInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid report synthesis request payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 201, store.createReportSynthesisRequest(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/reports/synthesis-requests") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = reportSynthesisRequestQuerySchema.safeParse({
          period: requestUrl.searchParams.get("period") ?? undefined,
          date: requestUrl.searchParams.get("date") ?? undefined,
          from: requestUrl.searchParams.get("from") ?? undefined,
          to: requestUrl.searchParams.get("to") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          scopeType: requestUrl.searchParams.get("scopeType") ?? undefined,
          status: requestUrl.searchParams.get("status") ?? undefined,
          requestId: requestUrl.searchParams.get("requestId")?.trim() || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report synthesis request query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.listReportSynthesisRequests(parsed.data));
        return;
      }

      if (
        request.method === "POST" &&
        pathParts[0] === "api" &&
        pathParts[1] === "reports" &&
        pathParts[2] === "synthesis-requests" &&
        pathParts[3] &&
        pathParts.length === 5 &&
        pathParts[4] === "retry"
      ) {
        const parsed = retryReportSynthesisRequestInputSchema.safeParse({ requestId: pathParts[3] });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report synthesis retry request.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.retryReportSynthesisRequest(parsed.data.requestId));
        return;
      }

      if (
        request.method === "POST" &&
        pathParts[0] === "api" &&
        pathParts[1] === "reports" &&
        pathParts[2] === "synthesis-requests" &&
        pathParts[3] &&
        pathParts.length === 5 &&
        pathParts[4] === "cancel"
      ) {
        const parsed = cancelReportSynthesisRequestInputSchema.safeParse({ requestId: pathParts[3] });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report synthesis cancellation request.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.cancelReportSynthesisRequest(parsed.data.requestId));
        return;
      }

      if (
        request.method === "GET" &&
        pathParts[0] === "api" &&
        pathParts[1] === "reports" &&
        pathParts[2] === "synthesis-requests" &&
        pathParts[3] &&
        pathParts[4] === "context"
      ) {
        const parsed = reportSynthesisContextQuerySchema.safeParse({
          requestId: pathParts[3],
          maxSessions: requestUrl.searchParams.get("maxSessions")
            ? Number(requestUrl.searchParams.get("maxSessions"))
            : undefined,
          maxEvidence: requestUrl.searchParams.get("maxEvidence")
            ? Number(requestUrl.searchParams.get("maxEvidence"))
            : undefined,
          maxHandoffCharacters: requestUrl.searchParams.get("maxHandoffCharacters")
            ? Number(requestUrl.searchParams.get("maxHandoffCharacters"))
            : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report synthesis context query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.getReportSynthesisContext(parsed.data));
        return;
      }

      if (
        request.method === "GET" &&
        pathParts[0] === "api" &&
        pathParts[1] === "reports" &&
        pathParts[2] === "synthesis-requests" &&
        pathParts[3]
      ) {
        sendJson(response, 200, store.getReportSynthesisRequest(pathParts[3]));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/reports/summaries") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = reportSynthesisRequestQuerySchema.safeParse({
          period: requestUrl.searchParams.get("period") ?? undefined,
          date: requestUrl.searchParams.get("date") ?? undefined,
          from: requestUrl.searchParams.get("from") ?? undefined,
          to: requestUrl.searchParams.get("to") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          scopeType: requestUrl.searchParams.get("scopeType") ?? undefined,
          requestId: requestUrl.searchParams.get("requestId")?.trim() || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid report summary query.", parsed.error.flatten());
          return;
        }
        sendJson(
          response,
          200,
          store.listReportSummaries({
            ...parsed.data,
            currentOnly: requestUrl.searchParams.get("currentOnly") !== "false",
          }),
        );
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/reports/summaries") {
        const parsed = saveReportSummaryInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid report summary payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.saveReportSummary(parsed.data));
        return;
      }

      if (
        request.method === "DELETE" &&
        pathParts[0] === "api" &&
        pathParts[1] === "reports" &&
        pathParts[2] === "summaries" &&
        pathParts[3] &&
        pathParts.length === 4
      ) {
        sendJson(response, 200, store.deleteReportSummary(pathParts[3]));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/projects") {
        sendJson(response, 200, store.listProjects());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/project-deletion-audits") {
        sendJson(response, 200, store.listProjectDeletionAudits());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/knowledge/candidates") {
        const parsed = knowledgeCandidateListQuerySchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot")?.trim() || undefined,
          status: requestUrl.searchParams.get("status") || undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge candidate query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.listKnowledgeCandidates(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/knowledge/candidate-requests") {
        const parsed = requestKnowledgeCandidatesInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge candidate request.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.requestKnowledgeCandidates(parsed.data.projectRoot));
        return;
      }

      if (
        request.method === "POST" &&
        pathParts[0] === "api" &&
        pathParts[1] === "knowledge" &&
        pathParts[2] === "candidates" &&
        pathParts[3] &&
        pathParts[4] === "decision"
      ) {
        const parsed = decideKnowledgeCandidateInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          candidateId: pathParts[3],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge candidate decision.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.decideKnowledgeCandidate(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/knowledge") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = knowledgeQuerySchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot")?.trim() || undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          q: requestUrl.searchParams.get("q")?.trim() || undefined,
          kind: requestUrl.searchParams.get("kind") || undefined,
          status: requestUrl.searchParams.get("status") || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
          page: requestUrl.searchParams.get("page") ? Number(requestUrl.searchParams.get("page")) : undefined,
          pageSize: requestUrl.searchParams.get("pageSize")
            ? Number(requestUrl.searchParams.get("pageSize"))
            : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.searchKnowledge(parsed.data));
        return;
      }

      if (
        request.method === "GET" &&
        pathParts[0] === "api" &&
        pathParts[1] === "knowledge" &&
        pathParts[2] &&
        pathParts[3] === "history"
      ) {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = knowledgeHistoryQuerySchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot") ?? "",
          knowledgeId: pathParts[2],
          limit: rawLimit ? Number(rawLimit) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge history query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.getKnowledgeHistory(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/graph") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const rawMaxNodes = requestUrl.searchParams.get("maxNodes");
        const rawMaxEdges = requestUrl.searchParams.get("maxEdges");
        const rawPageSize = requestUrl.searchParams.get("pageSize");
        const parsed = graphQuerySchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot")?.trim() || undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
          maxNodes: rawMaxNodes ? Number(rawMaxNodes) : undefined,
          maxEdges: rawMaxEdges ? Number(rawMaxEdges) : undefined,
          pageSize: rawPageSize ? Number(rawPageSize) : undefined,
          cursor: requestUrl.searchParams.get("cursor")?.trim() || undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid graph query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.getGraph(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/knowledge") {
        const parsed = recordKnowledgeInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.recordKnowledge(parsed.data));
        return;
      }

      if (request.method === "PATCH" && pathParts[0] === "api" && pathParts[1] === "knowledge" && pathParts[2]) {
        const parsed = updateKnowledgeInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          knowledgeId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid knowledge update payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.updateKnowledge(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/projects") {
        const parsed = createProjectInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid project payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 201, store.addProject(parsed.data.name, parsed.data.rootPath));
        return;
      }

      if (
        request.method === "DELETE" &&
        pathParts[0] === "api" &&
        pathParts[1] === "projects" &&
        pathParts[2] &&
        pathParts.length === 3
      ) {
        const parsed = deleteProjectInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid project deletion confirmation.", parsed.error.flatten());
          return;
        }
        try {
          sendJson(response, 200, store.deleteProject(pathParts[2], parsed.data.confirmationName));
        } catch (error) {
          if (!(error instanceof ProjectDeletionError)) {
            throw error;
          }
          switch (error.code) {
            case "PROJECT_NOT_FOUND":
              sendError(response, 404, "Project not found.");
              return;
            case "PROJECT_NAME_MISMATCH":
              sendError(response, 409, "The confirmation name does not match the project name.");
              return;
            case "PROJECT_BACKUP_FAILED":
              sendError(
                response,
                503,
                "The required pre-deletion backup could not be created; the project was not deleted.",
              );
              return;
            case "PROJECT_DELETE_FAILED":
              sendError(response, 500, "Project deletion failed; the pre-deletion backup is preserved.");
              return;
          }
        }
        return;
      }

      if (request.method === "PATCH" && pathParts[0] === "api" && pathParts[1] === "projects" && pathParts[2]) {
        const parsed = updateProjectInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid project update payload.", parsed.error.flatten());
          return;
        }
        const project = store.updateProject(pathParts[2], parsed.data);
        if (!project) {
          sendError(response, 404, "Project not found.");
          return;
        }
        sendJson(response, 200, project);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const parsed = sessionsQuerySchema.safeParse({
          q: requestUrl.searchParams.get("q")?.trim() || undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          voided: requestUrl.searchParams.get("voided") || undefined,
          from: requestUrl.searchParams.get("from") || undefined,
          to: requestUrl.searchParams.get("to") || undefined,
          page: requestUrl.searchParams.get("page") ? Number(requestUrl.searchParams.get("page")) : undefined,
          pageSize: requestUrl.searchParams.get("pageSize")
            ? Number(requestUrl.searchParams.get("pageSize"))
            : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session filters.", parsed.error.flatten());
          return;
        }
        sendJson(
          response,
          200,
          store.listSessionsPage({
            query: parsed.data.q,
            projectId: parsed.data.projectId,
            voided: parsed.data.voided,
            from: parsed.data.from,
            to: parsed.data.to,
            page: parsed.data.page,
            pageSize: parsed.data.pageSize,
            // Worklog shows tracked projects only, matching Session detail, search and reports.
            trackedOnly: true,
          }),
        );
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/backfill/metadata/preview") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = metadataBackfillPreviewQuerySchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot")?.trim() || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill preview query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.previewMetadataBackfill(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/backfill/metadata-requests") {
        const parsed = createMetadataBackfillRequestInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill request payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 201, store.createMetadataBackfillRequest(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/backfill/metadata-requests") {
        const rawLimit = requestUrl.searchParams.get("limit");
        const parsed = metadataBackfillRequestQuerySchema.safeParse({
          scopeType: requestUrl.searchParams.get("scopeType") ?? undefined,
          projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined,
          status: requestUrl.searchParams.get("status") ?? undefined,
          requestId: requestUrl.searchParams.get("requestId")?.trim() || undefined,
          limit: rawLimit ? Number(rawLimit) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill request query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.listMetadataBackfillRequests(parsed.data));
        return;
      }

      if (
        request.method === "GET" &&
        pathParts[0] === "api" &&
        pathParts[1] === "backfill" &&
        pathParts[2] === "metadata-requests" &&
        pathParts[3] &&
        pathParts[4] === "context"
      ) {
        const parsed = metadataBackfillRequestContextQuerySchema.safeParse({
          requestId: pathParts[3],
          limit: requestUrl.searchParams.get("limit") ? Number(requestUrl.searchParams.get("limit")) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill request context query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.getMetadataBackfillContext(parsed.data));
        return;
      }

      if (
        request.method === "POST" &&
        pathParts[0] === "api" &&
        pathParts[1] === "backfill" &&
        pathParts[2] === "metadata-requests" &&
        pathParts[3] &&
        pathParts.length === 5 &&
        pathParts[4] === "cancel"
      ) {
        const parsed = cancelMetadataBackfillRequestInputSchema.safeParse({ requestId: pathParts[3] });
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill cancellation request.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.cancelMetadataBackfillRequest(parsed.data.requestId));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/backfill/metadata") {
        const parsed = metadataBackfillApplyInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid metadata backfill payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.applyMetadataBackfill(parsed.data));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/imports/handoffs/preview") {
        const rawMaxFiles = requestUrl.searchParams.get("maxFiles");
        const parsed = handoffImportOptionsSchema.safeParse({
          projectRoot: requestUrl.searchParams.get("projectRoot") ?? "",
          handoffDirectory: requestUrl.searchParams.get("handoffDirectory") ?? undefined,
          excludePaths: requestUrl.searchParams.getAll("excludePath"),
          maxFiles: rawMaxFiles ? Number(rawMaxFiles) : undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid handoff import preview query.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.previewHandoffImport(parsed.data));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/imports/handoffs") {
        const parsed = handoffImportApplyInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid handoff import payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.importHandoffs(parsed.data));
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "metadata"
      ) {
        const parsed = updateSessionMetadataInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session metadata payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.updateSessionMetadata(parsed.data));
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "summary"
      ) {
        const parsed = updateSessionSummaryInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session summary payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.updateSessionSummary(parsed.data));
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "work-summary"
      ) {
        const parsed = updateSessionWorkSummaryInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session workSummary payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.updateSessionWorkSummary(parsed.data));
        return;
      }

      if (
        request.method === "POST" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "evidence"
      ) {
        const parsed = attachEvidenceInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid evidence payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.attachEvidence(parsed.data));
        return;
      }

      if (
        (request.method === "POST" || request.method === "DELETE") &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "links"
      ) {
        const body = request.method === "POST" ? ((await readJsonBody(request)) as Record<string, unknown>) : {};
        const parsed = linkSessionsInputSchema.safeParse({
          ...body,
          ...(request.method === "DELETE" ? { relatedSessionId: pathParts[4], linked: false } : { linked: true }),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session link payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.linkSessions(parsed.data, "web"));
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "verification"
      ) {
        const parsed = updateSessionVerificationInputSchema.safeParse({
          verification: await readJsonBody(request),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session verification payload.", parsed.error.flatten());
          return;
        }
        sendJson(
          response,
          200,
          store.updateSessionVerification(parsed.data.sessionId, parsed.data.verification, "web"),
        );
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "sessions" &&
        pathParts[2] &&
        pathParts[3] === "void"
      ) {
        const parsed = setSessionVoidInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          sessionId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid session void payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.setSessionVoid(parsed.data));
        return;
      }

      if (
        request.method === "PATCH" &&
        pathParts[0] === "api" &&
        pathParts[1] === "evidence" &&
        pathParts[2] &&
        pathParts[3] === "void"
      ) {
        const parsed = setEvidenceVoidInputSchema.safeParse({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          evidenceId: pathParts[2],
        });
        if (!parsed.success) {
          sendError(response, 400, "Invalid evidence void payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.setEvidenceVoid(parsed.data));
        return;
      }

      if (request.method === "GET" && pathParts[0] === "api" && pathParts[1] === "sessions" && pathParts[2]) {
        const detail = store.getSessionDetail(pathParts[2]);
        if (!detail) {
          sendError(response, 404, "Session not found.");
          return;
        }
        sendJson(response, 200, detail);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/context") {
        sendJson(response, 200, store.getContext(requestUrl.searchParams.get("projectRoot") ?? undefined));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/search") {
        const parsed = searchQuerySchema.safeParse({
          q: requestUrl.searchParams.get("q") ?? "",
          projectRoot: requestUrl.searchParams.get("projectRoot") ?? undefined,
        });
        if (!parsed.success) {
          sendError(response, 400, "A non-empty search query is required.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.search(parsed.data.q, parsed.data.projectRoot));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/work/finalize") {
        const parsed = finalizeSessionInputSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          sendError(response, 400, "Invalid finalize payload.", parsed.error.flatten());
          return;
        }
        sendJson(response, 200, store.finalizeSession(parsed.data));
        return;
      }

      if (serveWebFiles && pathParts[0] !== "api" && (await serveWebFiles(request, response))) {
        return;
      }

      sendError(response, 404, "Route not found.");
    } catch (error) {
      if (error instanceof RequestBodyError) {
        sendError(response, error.statusCode, error.message);
        return;
      }

      if (isDatabaseBusyError(error)) {
        sendError(response, 503, DATABASE_BUSY_MESSAGE);
        return;
      }

      console.error("[work-intelligence] API request failed", error);
      if (response.headersSent) {
        // A streamed download failed midway; cut the connection so the client sees an incomplete file.
        response.destroy();
        return;
      }
      sendError(response, 500, "Internal server error.");
    }
  };

  return Object.assign(handler, {
    closeEventStreams(): void {
      stopEventPolling();
      for (const client of eventClients) {
        if (client.destroyed || client.writableEnded) {
          continue;
        }
        try {
          client.end();
        } catch {
          client.destroy();
        }
      }
      eventClients.clear();
    },
  });
}

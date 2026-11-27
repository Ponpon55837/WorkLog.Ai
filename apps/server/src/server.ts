import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type {
  ApiErrorCode,
  FolderPickResult,
  SystemAgentConnections,
  UserServiceStatus,
} from "@work-intelligence/core";
import {
  databaseUnavailableMessage,
  databaseUnavailableReason,
  type DatabaseUnavailableReason,
  isDatabaseSchemaChangedError,
  WorkIntelligenceStore,
} from "@work-intelligence/storage";
import {
  computeInstanceProof,
  INSTANCE_CHALLENGE_HEADER,
  isValidInstanceChallenge,
} from "@work-intelligence/shared/instance-proof";
import type { DesktopBackendActivity } from "@work-intelligence/schema";
import { getMcpLeaseScopeId, getMcpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { createFolderPicker } from "./folder-picker.js";
import { BackupWorkerOutOfMemoryError, BackupWorkerTimeoutError } from "./backup-worker-errors.js";
import { inspectAgentConnections } from "./doctor.js";
import {
  importProjectDataUpload,
  inspectStagedProjectDataImport,
  JSON_HEADERS,
  previewProjectDataImportUpload,
  RequestBodyError,
  sendError,
} from "./http.js";
import { StagedImports } from "./staged-imports.js";
import { transferRoot as defaultTransferRoot } from "./transfer-workspace.js";
import { defaultUsageScanContext, InlineUsageOperations, type UsageOperations } from "./usage-scan.js";
import { getUserServiceStatusAsync } from "./user-service.js";
import { mcpLeaseDiagnosis, withHostObservations } from "./agent-observations.js";
import { createDesktopRouteServices, type DesktopHandlerOptions } from "./desktop-services.js";
import { Router, apiRoutes, type BackgroundStoreOperations, type RouteServices } from "./routes/index.js";
import { resolveWebDirectory } from "./web-directory.js";
import { applyProductionSecurityHeaders, createStaticFilesHandler } from "./static-files.js";

const DEFAULT_EVENT_POLL_INTERVAL_MS = 2_000;
const DATABASE_UNAVAILABLE_RESPONSES: Record<DatabaseUnavailableReason, { status: number; code: ApiErrorCode }> = {
  busy: { status: 503, code: "database_busy" },
  read_only: { status: 503, code: "database_read_only" },
  disk_full: { status: 507, code: "database_disk_full" },
};
const SERVER_RESTART_REQUIRED_MESSAGE = "資料庫 schema 已更新，請重新啟動 Work Intelligence server。";
const BACKUP_WORKER_OUT_OF_MEMORY_MESSAGE = "匯入檔太大，背景處理記憶體不足；後端仍正常運作。";
const BACKUP_WORKER_TIMEOUT_MESSAGE = "背景處理逾時而被停止；後端仍正常運作，請稍後再試。";
const DEFAULT_MAX_EVENT_CLIENTS = 32;
const EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const router = new Router(apiRoutes);

const defaultAllowedOrigins = resolveWebDirectory() ? "" : "http://127.0.0.1:5966,http://localhost:5966";
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

// DNS rebinding guard: a rebound page's GETs carry no Origin header, but Host still names the attacker's domain or port.
// Only loopback names on the listening port, and the exact host:port of an allowlisted origin, pass.
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
const allowedOriginHosts = new Set<string>();
// An origin on its scheme's default port is also reached without a port in Host (for example behind a TLS proxy).
const allowedPortlessHostnames = new Set<string>();
for (const origin of allowedOrigins) {
  try {
    const url = new URL(origin);
    allowedOriginHosts.add(`${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`);
    if (!url.port) allowedPortlessHostnames.add(url.hostname);
  } catch {
    // An unparsable origin cannot match a browser Origin header either; ignore it here.
  }
}

function isAllowedHost(hostHeader: string | undefined, listenPort: number | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  try {
    const { hostname, port } = new URL(`http://${hostHeader}`);
    const hostPort = `${hostname}:${port || "80"}`;
    if (allowedOriginHosts.has(hostPort)) {
      return true;
    }
    if (!/:\d+$/.test(hostHeader) && allowedPortlessHostnames.has(hostname)) {
      return true;
    }
    // In-process test requests have no real socket, so there is no listening port to compare.
    const portMatches = listenPort === undefined || hostPort === `${hostname}:${listenPort}`;
    return portMatches && LOOPBACK_HOSTNAMES.includes(hostname);
  } catch {
    return false;
  }
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin || isSameOrigin(request, origin) || !allowedOrigins.has(origin)) {
    return;
  }

  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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

/** @internal test-only */
export interface ApiHandlerOptions {
  pickFolder?: () => Promise<FolderPickResult>;
  eventPollIntervalMs?: number;
  maxEventClients?: number;
  webDirectory?: string;
  repositoryRoot?: string;
  mcpRuntimeStatus?: () => ReturnType<typeof getMcpRuntimeStatus>;
  agentConnections?: () => SystemAgentConnections;
  userServiceStatus?: () => UserServiceStatus | Promise<UserServiceStatus>;
  backgroundStore?: BackgroundStoreOperations;
  usage?: UsageOperations;
  backgroundActivity?: () => readonly DesktopBackendActivity[];
  transferRoot?: string;
  /**
   * When set, `/api/health` answers a valid challenge header with an HMAC proof so the parent can tell this process
   * from a squatter on the port; the id itself is never sent.
   */
  instanceRunId?: string;
  desktop?: DesktopHandlerOptions;
}

/** @internal test-only */
export type ApiHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
  closeEventStreams: () => void;
  discardStagedImports: () => void;
  activity: () => DesktopBackendActivity[];
  hasPendingImport: () => boolean;
};

function createInlineBackgroundStore(store: WorkIntelligenceStore): BackgroundStoreOperations {
  return {
    async createBackup() {
      return store.createBackup();
    },
    async backupIfDue() {
      return store.backupIfDue();
    },
    async exportTo(target, options) {
      return store.exportTo(target, options);
    },
    async exportProjectData(scope, target, maxBytes) {
      return store.writeProjectDataExport(scope, target, maxBytes);
    },
    async previewProjectDataImport(upload) {
      return previewProjectDataImportUpload(store, upload);
    },
    async importProjectData(upload) {
      return importProjectDataUpload(store, upload);
    },
    async inspectStagedProjectDataImport(upload) {
      return inspectStagedProjectDataImport(store, upload);
    },
    async close() {},
  };
}

export function createApiHandler(store: WorkIntelligenceStore, options: ApiHandlerOptions = {}): ApiHandler {
  const pickFolder = options.pickFolder ?? createFolderPicker();
  const serveWebFiles = options.webDirectory ? createStaticFilesHandler(options.webDirectory) : undefined;
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const inspectConnections =
    options.agentConnections ??
    (() => {
      const facts = options.desktop?.getFacts ? options.desktop.getFacts() : options.desktop?.facts;
      const connections = inspectAgentConnections({
        repositoryRoot,
        ...(facts?.launcherShimPath ? { shimPath: facts.launcherShimPath } : {}),
      });
      return facts?.runtimeRoot ? withHostObservations(connections, facts.runtimeRoot) : connections;
    });
  const queryUserService = options.userServiceStatus ?? (() => getUserServiceStatusAsync({ repositoryRoot }));
  const backgroundStore = options.backgroundStore ?? createInlineBackgroundStore(store);
  const transferRoot = options.transferRoot ?? defaultTransferRoot(store.databasePath);
  const stagedImports = new StagedImports(transferRoot);
  let cachedUserService: { status: UserServiceStatus; expiresAt: number } | undefined;
  let pendingUserService: Promise<UserServiceStatus> | undefined;
  function inspectUserService(): Promise<UserServiceStatus> {
    if (cachedUserService && Date.now() < cachedUserService.expiresAt) return Promise.resolve(cachedUserService.status);
    if (pendingUserService) return pendingUserService;
    pendingUserService = Promise.resolve()
      .then(queryUserService)
      .then((status) => {
        if (status.state !== "unavailable") cachedUserService = { status, expiresAt: Date.now() + 30_000 };
        return status;
      })
      .finally(() => {
        pendingUserService = undefined;
      });
    return pendingUserService;
  }
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

  function publishEvent(event: "changed" | "agent-reads-changed"): void {
    for (const client of eventClients) {
      if (client.destroyed || client.writableEnded) {
        eventClients.delete(client);
        continue;
      }
      try {
        // Both event types are deliberately data-free; the browser refetches through the normal API.
        client.write(`event: ${event}\ndata:\n\n`);
      } catch {
        eventClients.delete(client);
      }
    }
    lastHeartbeatAt = Date.now();
  }

  function pollDatabaseChanges(): void {
    try {
      const changeToken = store.getChangeToken();
      const databaseChanged =
        changeToken.databaseId !== lastChangeToken.databaseId ||
        changeToken.dataRevision !== lastChangeToken.dataRevision;
      const agentReadsChanged = changeToken.auditRevision !== lastChangeToken.auditRevision;
      if (databaseChanged || agentReadsChanged) {
        lastChangeToken = changeToken;
        if (databaseChanged) publishEvent("changed");
        if (agentReadsChanged) publishEvent("agent-reads-changed");
        return;
      }
    } catch {
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

  const services: RouteServices = {
    pickFolder,
    startEventStream,
    eventClientCount: () => eventClients.size,
    mcpRuntimeStatus: options.mcpRuntimeStatus ?? (() => getMcpRuntimeStatus(repositoryRoot)),
    mcpLeaseDiagnosis: (activeLeases) => mcpLeaseDiagnosis(getMcpLeaseScopeId(repositoryRoot), activeLeases),
    agentConnections: inspectConnections,
    userServiceStatus: inspectUserService,
    ...(options.desktop ? { desktop: createDesktopRouteServices(options.desktop, store.backupDirectory) } : {}),
    backgroundStore,
    usage:
      options.usage ??
      new InlineUsageOperations(
        defaultUsageScanContext(store.databasePath === ":memory:" ? undefined : dirname(store.databasePath)),
      ),
    transferRoot,
    stagedImports,
    instanceProof: (request) => {
      const challenge = request.headers[INSTANCE_CHALLENGE_HEADER];
      return options.instanceRunId && isValidInstanceChallenge(challenge)
        ? computeInstanceProof(options.instanceRunId, challenge)
        : undefined;
    },
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (serveWebFiles) {
      applyProductionSecurityHeaders(response);
    }
    if (!isAllowedHost(request.headers.host, request.socket?.localPort)) {
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

    try {
      const matched = router.match(request.method ?? "GET", requestUrl.pathname);
      if (matched) {
        await matched.route.handler({
          store,
          request,
          response,
          url: requestUrl,
          params: matched.params,
          services,
        });
        return;
      }

      const isApiPath = requestUrl.pathname.split("/").find(Boolean) === "api";
      if (serveWebFiles && !isApiPath && (await serveWebFiles(request, response))) {
        return;
      }

      sendError(response, 404, "Route not found.");
    } catch (error) {
      if (error instanceof RequestBodyError) {
        sendError(response, error.statusCode, error.message);
        return;
      }

      if (response.headersSent) {
        // A streamed download failed midway (busy or otherwise); headers are gone, so cut the connection
        // and let the client see an incomplete file instead of throwing while writing a second response.
        console.error("[work-intelligence] API request failed after the response started", error);
        response.destroy();
        return;
      }

      if (isDatabaseSchemaChangedError(error)) {
        sendError(response, 503, SERVER_RESTART_REQUIRED_MESSAGE, undefined, "server_restart_required");
        return;
      }

      if (error instanceof BackupWorkerOutOfMemoryError) {
        // 413, not 500: retrying the same document cannot succeed; the code keeps it apart from `payload_too_large`.
        sendError(response, 413, BACKUP_WORKER_OUT_OF_MEMORY_MESSAGE, undefined, error.code);
        return;
      }

      if (error instanceof BackupWorkerTimeoutError) {
        sendError(response, 503, BACKUP_WORKER_TIMEOUT_MESSAGE, undefined, "service_unavailable");
        return;
      }

      const unavailable = databaseUnavailableReason(error);
      if (unavailable) {
        const { status, code } = DATABASE_UNAVAILABLE_RESPONSES[unavailable];
        sendError(response, status, databaseUnavailableMessage(unavailable), undefined, code);
        return;
      }

      console.error("[work-intelligence] API request failed", error);
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
    discardStagedImports(): void {
      stagedImports.clear();
    },
    activity(): DesktopBackendActivity[] {
      const kinds = new Set<DesktopBackendActivity>(options.backgroundActivity?.() ?? []);
      if (stagedImports.inUse) kinds.add("import");
      return [...kinds];
    },
    hasPendingImport(): boolean {
      return stagedImports.pending;
    },
  });
}

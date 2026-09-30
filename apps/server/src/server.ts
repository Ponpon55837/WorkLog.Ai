import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { FolderPickResult, SystemAgentConnections, UserServiceStatus } from "@work-intelligence/core";
import { DATABASE_BUSY_MESSAGE, WorkIntelligenceStore, isDatabaseBusyError } from "@work-intelligence/storage";
import { getMcpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { createFolderPicker } from "./folder-picker.js";
import { inspectAgentConnections } from "./doctor.js";
import { JSON_HEADERS, RequestBodyError, sendError } from "./http.js";
import { getUserServiceStatus } from "./user-service.js";
import { Router, apiRoutes, type RouteServices } from "./routes/index.js";
import { applyProductionSecurityHeaders, createStaticFilesHandler } from "./static-files.js";

const DEFAULT_EVENT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_EVENT_CLIENTS = 32;
const EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Built once: the route table is static, and building it rejects duplicate routes at startup. */
const router = new Router(apiRoutes);

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

export interface ApiHandlerOptions {
  /** Shows the native folder dialog; injectable so tests never open a real window. */
  pickFolder?: () => Promise<FolderPickResult>;
  /** Polling interval for the SQLite change stream; configurable to keep integration tests fast. */
  eventPollIntervalMs?: number;
  /** Maximum number of simultaneous SSE clients. */
  maxEventClients?: number;
  /** Serves a built Web distribution on the same origin as this API server. */
  webDirectory?: string;
  /** Install root used for the shared MCP runtime registry; injectable for isolated tests. */
  repositoryRoot?: string;
  /** Read-only Agent diagnostics; injectable so API tests never inspect real user settings. */
  agentConnections?: () => SystemAgentConnections;
  /** Read-only login-service status; injectable so API tests never query the host service manager. */
  userServiceStatus?: () => UserServiceStatus;
}

export type ApiHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
  closeEventStreams: () => void;
};

export function createApiHandler(store: WorkIntelligenceStore, options: ApiHandlerOptions = {}): ApiHandler {
  const pickFolder = options.pickFolder ?? createFolderPicker();
  const serveWebFiles = options.webDirectory ? createStaticFilesHandler(options.webDirectory) : undefined;
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const inspectConnections = options.agentConnections ?? (() => inspectAgentConnections({ repositoryRoot }));
  const inspectUserService = options.userServiceStatus ?? (() => getUserServiceStatus({ repositoryRoot }));
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

  const services: RouteServices = {
    pickFolder,
    startEventStream,
    eventClientCount: () => eventClients.size,
    mcpRuntimeStatus: () => getMcpRuntimeStatus(repositoryRoot),
    agentConnections: inspectConnections,
    userServiceStatus: inspectUserService,
  };

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

      if (isDatabaseBusyError(error)) {
        sendError(response, 503, DATABASE_BUSY_MESSAGE, undefined, "database_busy");
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
  });
}

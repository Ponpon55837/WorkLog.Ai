import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemAgentConnections, UserServiceManager, UserServiceStatus } from "../../packages/core/src/index.js";
import { APP_VERSION } from "../../packages/shared/src/app-version.js";
import { canonicalizeProjectRoot } from "../../packages/project-policy/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler, type ApiHandlerOptions } from "../../apps/server/src/server.js";
import {
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  readMcpBuildIdentity,
  registerMcpProcess,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture, finalizeMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

const resources: Array<{
  server: Server;
  store: WorkIntelligenceStore;
  root: string;
  mcpRuntimeRoot?: string;
  mcpCleanup?: () => void;
}> = [];

function isolatedUserServiceStatus(root: string): UserServiceStatus {
  const manager: UserServiceManager | null =
    process.platform === "darwin"
      ? "LaunchAgent"
      : process.platform === "linux"
        ? "systemd --user"
        : process.platform === "win32"
          ? "Task Scheduler"
          : null;
  return {
    supported: manager !== null,
    state: manager ? "not_installed" : "unsupported",
    manager,
    enabled: false,
    running: false,
    configPath: join(root, "service", "work-intelligence.conf"),
    databasePath: join(root, "service-data", "work-intelligence.sqlite"),
    backupDirectory: join(root, "service-data", "backups"),
    logPath: join(root, "service-logs", "server.log"),
  };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.mcpCleanup?.();
    if (resource.mcpRuntimeRoot) {
      rmSync(getMcpRuntimeDirectory(resource.mcpRuntimeRoot), { recursive: true, force: true });
    }
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

async function startApi(
  store: WorkIntelligenceStore,
  options: ApiHandlerOptions = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createApiHandler(store, options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test API did not expose a TCP address.");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs = 2_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out waiting for SSE marker: ${marker}`)), timeoutMs);
    });
    while (!output.includes(marker)) {
      const chunkPromise = reader.read();
      const chunk = await Promise.race([chunkPromise, timeoutPromise]);
      if (chunk.done) {
        throw new Error("The SSE stream ended before the expected event arrived.");
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("Work Intelligence REST API", () => {
  it("rejects untrusted browser origins and does not expose the database path", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-security-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const rejected = await fetch(`${baseUrl}/api/health`, { headers: { origin: "http://evil.example" } });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "Origin is not allowed.", code: "origin_not_allowed" });

    const rejectedEventOrigin = await fetch(`${baseUrl}/api/events`, {
      headers: { origin: "http://evil.example" },
    });
    expect(rejectedEventOrigin.status).toBe(403);
    expect(await rejectedEventOrigin.json()).toMatchObject({
      error: "Origin is not allowed.",
      code: "origin_not_allowed",
    });

    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: "http://127.0.0.1:5966" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5966");
    expect(await allowed.json()).toMatchObject({
      ok: true,
      database: "connected",
      version: APP_VERSION,
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
  });

  it("returns read-only system status with database, backup, maintenance, and SSE metrics", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-system-status-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const automatic = store.backupIfDue(new Date("2026-09-25T12:00:00.000Z"));
    const manual = store.createBackup();
    if (!automatic || manual.outcome !== "database_backups") {
      throw new Error("The system status fixture could not create both backup kinds.");
    }

    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `INSERT INTO database_maintenance_runs
          (id, started_at, completed_at, status, backup_file_name, indexed_sessions, indexed_knowledge,
           indexed_chunks, indexed_paths, failure_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "system-status-test",
        "2026-09-24T09:00:00.000Z",
        "2026-09-24T09:01:00.000Z",
        "completed",
        "maintenance.sqlite",
        5,
        2,
        14,
        4,
        null,
      );
    database.close();

    const repositoryRoot = createMcpRuntimeFixture(join(root, "runtime-install"));
    const runningBuild = readMcpBuildIdentity(repositoryRoot);
    if (!runningBuild) throw new Error("The synthetic API runtime has no build identity.");
    const stopMcpProcess = registerMcpProcess(repositoryRoot, runningBuild);
    writeFileSync(
      join(repositoryRoot, "packages/storage/dist/index.js"),
      'export const runtime = "storage-after-start";\n',
    );
    finalizeMcpRuntimeFixture(repositoryRoot);
    const expectedMcpStatus = getMcpRuntimeStatus(repositoryRoot);
    const expectedAgents: SystemAgentConnections = {
      codex: { mcpRegistered: "registered", canonicalSkill: "current", legacySkill: "missing", hook: "installed" },
      claudeCode: { mcpRegistered: "missing", skill: "stale", hook: "missing" },
    };
    const expectedUserService = isolatedUserServiceStatus(root);
    const { server, baseUrl } = await startApi(store, {
      repositoryRoot,
      agentConnections: () => expectedAgents,
      userServiceStatus: () => expectedUserService,
    });
    resources.push({ server, store, root, mcpRuntimeRoot: repositoryRoot, mcpCleanup: stopMcpProcess });
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    const streamResponse = await fetch(`${baseUrl}/api/events`);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();

    const response = await requestJson<{
      version: string;
      schemaVersion: number;
      database: { path: string; bytes: number | null; state: string; schemaVersion: number | null };
      backups: {
        available: boolean;
        latestAutomatic: { kind: string; createdAt: string } | null;
        count: number;
        totalBytes: number;
      };
      maintenance: { status: string; backupFileName: string; indexedSessions: number } | null;
      userService: UserServiceStatus;
      mcp: {
        restartRequired: boolean;
        monitoringAvailable: boolean;
        activeProcesses: number;
        outdatedProcesses: number;
        message?: string;
      };
      agents: SystemAgentConnections;
      sseConnections: number;
    }>(baseUrl, "/api/system/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: APP_VERSION,
      schemaVersion: LATEST_SCHEMA_VERSION,
      database: { path: databasePath, state: "ok", schemaVersion: LATEST_SCHEMA_VERSION },
      backups: { available: true, latestAutomatic: { kind: "automatic", createdAt: "2026-09-25T12:00:00Z" }, count: 2 },
      maintenance: { status: "completed", backupFileName: "maintenance.sqlite", indexedSessions: 5 },
      userService: expectedUserService,
      mcp: expectedMcpStatus,
      agents: expectedAgents,
      sseConnections: 1,
    });
    expect(response.body.database.bytes).toBeGreaterThan(0);
    expect(response.body.backups.totalBytes).toBe(automatic.created.bytes + manual.created.bytes);
    expect(response.body.backups.latestAutomatic?.kind).toBe("automatic");
    const after = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(after).toBe(before);

    // Windows does not enforce POSIX directory write bits; the shared status test uses a portable probe seam.
    if (process.platform !== "win32") {
      const registryDirectory = getMcpRuntimeDirectory(repositoryRoot);
      chmodSync(registryDirectory, 0o500);
      try {
        const unavailable = await requestJson<{ mcp: Record<string, unknown> }>(baseUrl, "/api/system/status");
        expect(unavailable.body.mcp).toMatchObject({
          restartRequired: true,
          monitoringAvailable: false,
          activeProcesses: 0,
          outdatedProcesses: 0,
          message: expect.stringContaining("無法確認"),
        });
      } finally {
        chmodSync(registryDirectory, 0o700);
      }
    }

    await reader?.cancel();
  });

  it("rejects non-loopback Host headers so DNS-rebound pages cannot read the API", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root: mkdtempSync(join(tmpdir(), "work-intelligence-api-host-test-")) });
    const { port } = new URL(baseUrl);

    const statusForHost = (host: string, path = "/api/sessions") =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.once("error", reject);
        request.end();
      });

    expect(await statusForHost("rebind.evil.example")).toBe(421);
    expect(await statusForHost(`evil.example:${port}`)).toBe(421);
    expect(await statusForHost("rebind.evil.example", "/api/events")).toBe(421);
    expect(await statusForHost(`127.0.0.1:${port}`)).toBe(200);
    expect(await statusForHost("localhost:5966")).toBe(200);
  });

  it("streams a data-free changed event after another SQLite connection writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-events-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const { server, baseUrl } = await startApi(store, { eventPollIntervalMs: 10 });
    resources.push({ server, store, root });

    const response = await fetch(`${baseUrl}/api/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("The SSE response did not expose a readable stream.");
    }

    try {
      expect(await readSseUntil(reader, ": connected")).toContain(": connected");
      const agentStore = new WorkIntelligenceStore(databasePath);
      try {
        agentStore.addProject("External SQLite writer", join(root, "external-project"));
        const event = await readSseUntil(reader, "event: changed");
        expect(event).toContain("event: changed\ndata:\n\n");
        expect(event).not.toContain("External SQLite writer");
        expect(event).not.toContain(databasePath);
      } finally {
        agentStore.close();
      }
    } finally {
      await reader.cancel();
    }
  });

  it("rejects excess simultaneous SSE streams with retry guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-events-limit-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store, { maxEventClients: 1 });
    resources.push({ server, store, root });

    const first = await fetch(`${baseUrl}/api/events`);
    expect(first.status).toBe(200);
    const reader = first.body?.getReader();
    if (!reader) {
      throw new Error("The SSE response did not expose a readable stream.");
    }

    try {
      expect(await readSseUntil(reader, ": connected")).toContain(": connected");
      const rejected = await fetch(`${baseUrl}/api/events`);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("5");
      expect(await rejected.json()).toEqual({ error: "SSE connection limit reached.", code: "service_unavailable" });
    } finally {
      await reader.cancel();
    }
  });

  it("returns a safe 503 when another SQLite connection holds the write lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-busy-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const apiDatabase = (store as unknown as { db: DatabaseSync }).db;
    apiDatabase.exec("PRAGMA busy_timeout = 0");
    const lockConnection = new DatabaseSync(databasePath);
    lockConnection.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      const response = await requestJson<{ error: string }>(baseUrl, "/api/projects", {
        method: "POST",
        body: { name: "Locked project", rootPath: join(root, "locked-project") },
      });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "資料庫暫時忙碌，請稍後再試", code: "database_busy" });
    } finally {
      lockConnection.exec("ROLLBACK");
      lockConnection.close();
    }
  });

  it("returns the shared safe 503 when project deletion hits a SQLite write lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-delete-busy-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const project = store.addProject("Locked project", join(root, "locked-project"));
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const apiDatabase = (store as unknown as { db: DatabaseSync }).db;
    apiDatabase.exec("PRAGMA busy_timeout = 0");
    const lockConnection = new DatabaseSync(databasePath);
    lockConnection.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      const response = await requestJson<{ error: string }>(baseUrl, `/api/projects/${project.id}`, {
        method: "DELETE",
        body: { confirmationName: project.name },
      });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "資料庫暫時忙碌，請稍後再試", code: "database_busy" });
    } finally {
      lockConnection.exec("ROLLBACK");
      lockConnection.close();
    }
  });

  it("returns a safe client error for malformed JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-body-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const response = await fetch(`${baseUrl}/api/work/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid JSON request body.", code: "invalid_input" });

    const unsupported = await fetch(`${baseUrl}/api/work/finalize`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({}),
    });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: "Content-Type must be application/json.",
      code: "unsupported_media_type",
    });
  });

  it("updates a finalized session summary in place and keeps policy gating", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const project = store.addProject("API summary project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-summary-finalize-001",
      title: "API summary update",
      summary: "Original API summary.",
      changedFiles: ["src/feature.ts"],
      verification: { status: "passed", summary: "API test passed." },
      events: [{ type: "verification", summary: "The API update must preserve this event." }],
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized API test session");
    }
    store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "server.test.ts",
      summary: "REST API integration evidence.",
    });

    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const update = await requestJson<{
      outcome: string;
      duplicate?: boolean;
      session?: { id: string; summary: string };
    }>(baseUrl, `/api/sessions/${finalized.session.id}/summary`, {
      method: "PATCH",
      body: {
        idempotencyKey: "api-summary-update-001",
        mode: "append",
        summary: "補充 API 更新同一筆 Session 的主摘要。",
      },
    });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      outcome: "summary_updated",
      duplicate: false,
      session: {
        id: finalized.session.id,
        summary: "Original API summary.\n\n補充 API 更新同一筆 Session 的主摘要。",
      },
    });

    const retry = await requestJson<{ outcome: string; duplicate?: boolean }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/summary`,
      {
        method: "PATCH",
        body: {
          idempotencyKey: "api-summary-update-001",
          mode: "append",
          summary: "補充 API 更新同一筆 Session 的主摘要。",
        },
      },
    );
    expect(retry.body).toMatchObject({ outcome: "summary_updated", duplicate: true });

    const detail = await requestJson<{
      session: { summary: string; changedFiles: string[]; verification: { status: string } };
      events: Array<{ type: string }>;
      evidence: Array<{ reference: string }>;
    }>(baseUrl, `/api/sessions/${finalized.session.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      session: {
        summary: "Original API summary.\n\n補充 API 更新同一筆 Session 的主摘要。",
        changedFiles: ["src/feature.ts"],
        verification: { status: "passed" },
      },
      events: [expect.objectContaining({ type: "verification" }), expect.objectContaining({ type: "finalized" })],
      evidence: [expect.objectContaining({ reference: "server.test.ts" })],
    });

    store.updateProject(project.id, { status: "paused" });
    const skipped = await requestJson<{ outcome: string; projectStatus?: string }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/summary`,
      {
        method: "PATCH",
        body: { idempotencyKey: "api-summary-paused-001", summary: "Must not be written." },
      },
    );
    expect(skipped.body).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });

  it("updates a finalized workSummary in place through the API", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-work-summary-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const project = store.addProject("API workSummary project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-work-summary-finalize-001",
      title: "API workSummary update",
      summary: "Original structured session.",
      workSummary: {
        outcomes: ["完成 API 測試。"],
        scope: ["只更新同一筆 Session。"],
        decisions: ["使用 patch 語意。"],
        verification: ["REST test 已通過。"],
        nextSteps: ["等待補充。"],
      },
      changedFiles: ["src/api.ts"],
      verification: { status: "passed" },
      events: [{ type: "verification", summary: "Preserve API event." }],
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized API workSummary session");
    }
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const update = await requestJson<{
      outcome: string;
      duplicate?: boolean;
      session?: { id: string; workSummary: { nextSteps: string[] } };
    }>(baseUrl, `/api/sessions/${finalized.session.id}/work-summary`, {
      method: "PATCH",
      body: {
        idempotencyKey: "api-work-summary-update-001",
        mode: "patch",
        workSummary: { nextSteps: ["補充內容已完成。"] },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      outcome: "work_summary_updated",
      duplicate: false,
      session: {
        id: finalized.session.id,
        workSummary: { nextSteps: ["補充內容已完成。"] },
      },
    });

    const retry = await requestJson<{ outcome: string; duplicate?: boolean }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/work-summary`,
      {
        method: "PATCH",
        body: {
          idempotencyKey: "api-work-summary-update-001",
          mode: "patch",
          workSummary: { nextSteps: ["補充內容已完成。"] },
        },
      },
    );
    expect(retry.body).toMatchObject({ outcome: "work_summary_updated", duplicate: true });

    const detail = await requestJson<{
      session: {
        id: string;
        summary: string;
        changedFiles: string[];
        verification: { status: string };
        workSummary: { nextSteps: string[] };
      };
      events: Array<{ type: string }>;
    }>(baseUrl, `/api/sessions/${finalized.session.id}`);
    expect(detail.body).toMatchObject({
      session: {
        id: finalized.session.id,
        summary: "Original structured session.",
        changedFiles: ["src/api.ts"],
        verification: { status: "passed" },
        workSummary: { nextSteps: ["補充內容已完成。"] },
      },
      events: [expect.objectContaining({ type: "verification" }), expect.objectContaining({ type: "finalized" })],
    });
  });

  it("lists and counts Sessions of tracked projects only", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-tracked-only-test-"));
    const pausedRoot = join(root, "paused");
    mkdirSync(pausedRoot);
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const tracked = store.addProject("Tracked project", root);
    const paused = store.addProject("Paused project", pausedRoot);
    store.updateProject(tracked.id, { status: "tracked" });
    store.updateProject(paused.id, { status: "tracked" });
    const visible = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "tracked-visible",
      title: "Visible Session",
      summary: "Tracked.",
      changedFiles: ["src/full-list.ts"],
      workSummary: {
        outcomes: ["REST keeps complete list rows."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
    });
    const hidden = store.finalizeSession({
      projectRoot: pausedRoot,
      idempotencyKey: "paused-hidden",
      title: "Hidden Session",
      summary: "Paused later.",
    });
    expect(visible).toMatchObject({ outcome: "finalized" });
    expect(hidden).toMatchObject({ outcome: "finalized" });
    store.updateProject(paused.id, { status: "paused" });

    const list = await requestJson<{
      items: Array<{ title: string; changedFiles: string[]; workSummary: { outcomes: string[] } }>;
      pageInfo: { total: number };
    }>(baseUrl, "/api/sessions");
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.title)).toEqual(["Visible Session"]);
    expect(list.body.items[0]).toMatchObject({
      changedFiles: ["src/full-list.ts"],
      workSummary: { outcomes: ["REST keeps complete list rows."] },
    });
    expect(list.body.pageInfo.total).toBe(1);

    const scoped = await requestJson<{ items: unknown[] }>(baseUrl, `/api/sessions?projectId=${paused.id}`);
    expect(scoped.body.items).toEqual([]);

    const dashboard = await requestJson<{ finalizedSessions: number; recentSessions: Array<{ title: string }> }>(
      baseUrl,
      "/api/dashboard",
    );
    expect(dashboard.body.finalizedSessions).toBe(1);
    expect(dashboard.body.recentSessions.map((item) => item.title)).toEqual(["Visible Session"]);
  });

  it("filters Sessions by Agent client and lists the available clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-agent-source-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Agent source project", root);
    store.updateProject(project.id, { status: "tracked" });
    const base = { projectRoot: root, summary: "Fictional agent source work.", changedFiles: [] as string[] };
    store.finalizeSession(
      { ...base, idempotencyKey: "a1", title: "From fiction client" },
      { agentClient: "fiction-client" },
    );
    store.finalizeSession({ ...base, idempotencyKey: "a2", title: "Unknown client" });

    const agents = await requestJson<{ agents: string[] }>(baseUrl, "/api/sessions/agents");
    expect(agents).toMatchObject({ status: 200, body: { agents: ["fiction-client"] } });

    const filtered = await requestJson<{ items: Array<{ title: string; agentClient?: string }> }>(
      baseUrl,
      "/api/sessions?agent=fiction-client",
    );
    expect(filtered.body.items).toEqual([
      expect.objectContaining({ title: "From fiction client", agentClient: "fiction-client" }),
    ]);
    const none = await requestJson<{ items: unknown[] }>(baseUrl, "/api/sessions?agent=missing-client");
    expect(none.body.items).toEqual([]);
  });

  it("lists, paginates, and updates outstanding items through the Web API", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-outstanding-items-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const project = store.addProject("Outstanding items API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-outstanding-items-finalize",
      title: "Outstanding items source",
      summary: "Creates two pending items for the REST list.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["First API item.", "Second API item."],
      },
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected the outstanding-items source Session to finalize.");
    }
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const pending = await requestJson<{
      outcome: string;
      items: Array<{
        id: string;
        text: string;
        status: string;
        sourceSessionId: string;
        sourceSessionTitle: string;
        sourceSessionCompletedAt: string;
      }>;
      pageInfo: { page: number; pageSize: number; total: number };
    }>(baseUrl, `/api/outstanding-items?projectId=${project.id}&status=pending&page=1&pageSize=1`);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      outcome: "outstanding_items",
      items: [
        {
          text: "First API item.",
          status: "pending",
          sourceSessionId: finalized.session.id,
          sourceSessionTitle: "Outstanding items source",
        },
      ],
      pageInfo: { page: 1, pageSize: 1, total: 2 },
    });
    const item = pending.body.items[0];
    if (!item) throw new Error("Expected the first pending item on page one.");

    const completedAt = new Date(item.sourceSessionCompletedAt);
    const completedDate = [
      completedAt.getFullYear().toString().padStart(4, "0"),
      (completedAt.getMonth() + 1).toString().padStart(2, "0"),
      completedAt.getDate().toString().padStart(2, "0"),
    ].join("-");
    const dateFiltered = await requestJson<{
      items: Array<{ text: string }>;
      pageInfo: { total: number };
    }>(baseUrl, `/api/outstanding-items?projectId=${project.id}&from=${completedDate}&to=${completedDate}&pageSize=0`);
    expect(dateFiltered.status).toBe(200);
    expect(dateFiltered.body).toMatchObject({
      items: [{ text: "First API item." }, { text: "Second API item." }],
      pageInfo: { total: 2 },
    });

    const completed = await requestJson<{
      outcome: string;
      duplicate: boolean;
      item: { id: string; text: string; status: string; sourceSessionId: string };
    }>(baseUrl, `/api/outstanding-items/${item.id}`, { method: "PATCH", body: { status: "completed" } });
    expect(completed).toMatchObject({
      status: 200,
      body: {
        outcome: "outstanding_item_updated",
        duplicate: false,
        item: {
          id: item.id,
          text: "First API item.",
          status: "completed",
          sourceSessionId: finalized.session.id,
        },
      },
    });

    const remaining = await requestJson<{
      items: Array<{ id: string; text: string }>;
      pageInfo: { total: number };
    }>(baseUrl, `/api/outstanding-items?projectId=${project.id}`);
    expect(remaining.body).toMatchObject({ items: [{ text: "Second API item." }], pageInfo: { total: 1 } });
    const secondItem = remaining.body.items[0];
    if (!secondItem) throw new Error("Expected the remaining pending item.");

    const beforeBatchEvents = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;
    const batch = await requestJson<{
      outcome: string;
      duplicate: boolean;
      updatedItemIds: string[];
      items: Array<{ id: string; status: string }>;
    }>(baseUrl, "/api/outstanding-items/batch", {
      method: "PATCH",
      body: { itemIds: [item.id, secondItem.id], status: "completed" },
    });
    expect(batch).toMatchObject({
      status: 200,
      body: {
        outcome: "outstanding_items_updated",
        duplicate: false,
        updatedItemIds: [secondItem.id],
        items: [
          expect.objectContaining({ id: item.id, status: "completed" }),
          expect.objectContaining({ id: secondItem.id, status: "completed" }),
        ],
      },
    });
    const afterBatchEvents = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;
    expect(afterBatchEvents).toHaveLength(beforeBatchEvents.length + 1);

    const repeatedBatch = await requestJson<{ outcome: string; duplicate: boolean }>(
      baseUrl,
      "/api/outstanding-items/batch",
      { method: "PATCH", body: { itemIds: [item.id, secondItem.id], status: "completed" } },
    );
    expect(repeatedBatch).toMatchObject({
      status: 200,
      body: { outcome: "outstanding_items_updated", duplicate: true },
    });
    expect(
      store.exportProjectData({ type: "project", projectId: project.id }).tables.outstanding_item_events,
    ).toHaveLength(afterBatchEvents.length);

    const conflict = await requestJson(baseUrl, "/api/outstanding-items/batch", {
      method: "PATCH",
      body: { itemIds: [item.id, secondItem.id], status: "pending", expectedStatus: "pending" },
    });
    expect(conflict.status).toBe(409);
    const invalidItems = await requestJson(baseUrl, "/api/outstanding-items/batch", {
      method: "PATCH",
      body: { itemIds: [item.id, "missing-api-outstanding-item"], status: "pending" },
    });
    expect(invalidItems.status).toBe(400);
    const invalidBody = await requestJson(baseUrl, "/api/outstanding-items/batch", {
      method: "PATCH",
      body: { itemIds: [item.id], status: "pending", extra: true },
    });
    expect(invalidBody.status).toBe(400);

    store.updateProject(project.id, { status: "paused" });
    const skippedList = await requestJson<{ outcome: string; projectStatus: string }>(
      baseUrl,
      `/api/outstanding-items?projectId=${project.id}`,
    );
    expect(skippedList.body).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    const skippedUpdate = await requestJson<{ outcome: string; projectStatus: string }>(
      baseUrl,
      `/api/outstanding-items/${item.id}`,
      { method: "PATCH", body: { status: "not_needed" } },
    );
    expect(skippedUpdate.body).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    const skippedBatch = await requestJson<{ outcome: string; projectStatus: string }>(
      baseUrl,
      "/api/outstanding-items/batch",
      { method: "PATCH", body: { itemIds: [item.id, secondItem.id], status: "pending" } },
    );
    expect(skippedBatch).toMatchObject({
      status: 200,
      body: { outcome: "skipped", projectStatus: "paused" },
    });
  });

  it("validates outstanding item filters and masks storage errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-outstanding-items-validation-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    store.listOutstandingItems = () => {
      throw new Error("private outstanding item storage detail");
    };
    store.updateOutstandingItemStatus = () => {
      throw new Error("private outstanding item storage detail");
    };
    store.batchUpdateOutstandingItemStatus = () => {
      throw new Error("private outstanding item storage detail");
    };
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const invalidFilters = await requestJson<{ code: string }>(baseUrl, "/api/outstanding-items?status=resolved");
    expect(invalidFilters.status).toBe(400);
    expect(invalidFilters.body.code).toBe("invalid_input");
    const invalidCalendarDate = await requestJson<{ code: string }>(baseUrl, "/api/outstanding-items?from=2026-02-30");
    expect(invalidCalendarDate.status).toBe(400);
    const reversedDateRange = await requestJson<{ code: string }>(
      baseUrl,
      "/api/outstanding-items?from=2026-09-30&to=2026-09-01",
    );
    expect(reversedDateRange.status).toBe(400);
    const invalidStatus = await requestJson<{ code: string }>(baseUrl, "/api/outstanding-items/item-1", {
      method: "PATCH",
      body: { status: "resolved" },
    });
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body.code).toBe("invalid_input");

    for (const result of [
      await requestJson<{ error: string; code: string }>(baseUrl, "/api/outstanding-items"),
      await requestJson<{ error: string; code: string }>(baseUrl, "/api/outstanding-items/item-1", {
        method: "PATCH",
        body: { status: "completed" },
      }),
    ]) {
      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({ error: "Internal server error.", code: "internal_error" });
      expect(JSON.stringify(result.body)).not.toContain("private outstanding item storage detail");
    }
    const hiddenBatchError = await requestJson<{ error: string; code: string }>(
      baseUrl,
      "/api/outstanding-items/batch",
      { method: "PATCH", body: { itemIds: ["item-1"], status: "completed" } },
    );
    expect(hiddenBatchError.status).toBe(500);
    expect(hiddenBatchError.body).toMatchObject({ error: "Internal server error.", code: "internal_error" });
    expect(JSON.stringify(hiddenBatchError.body)).not.toContain("private outstanding item storage detail");
  });

  it("lists, confirms, and promotes Agent decisions through the Web review API", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-session-decisions-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Decision API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-session-decisions",
      title: "Agent decision API fixture",
      summary: "Exercises the Web-only decision review routes.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [
          { text: "Confirm the first autonomous choice.", origin: "agent_autonomous" },
          { text: "Promote the second autonomous choice.", origin: "agent_autonomous" },
        ],
        verification: [],
        nextSteps: [],
      },
      completedAt: "2026-09-26T12:00:00.000Z",
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected the API fixture Session to finalize.");

    const listed = await requestJson<{
      outcome: string;
      pendingCount: number;
      items: Array<{ id: string; text: string; sessionId: string; sessionTitle: string; origin: string }>;
    }>(baseUrl, `/api/session-decisions?projectRoot=${encodeURIComponent(root)}&status=pending`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      outcome: "session_decisions",
      pendingCount: 2,
      items: [
        {
          text: "Confirm the first autonomous choice.",
          sessionId: finalized.session.id,
          sessionTitle: finalized.session.title,
          origin: "agent_autonomous",
        },
        {
          text: "Promote the second autonomous choice.",
          sessionId: finalized.session.id,
          sessionTitle: finalized.session.title,
          origin: "agent_autonomous",
        },
      ],
    });

    const confirmTarget = listed.body.items.find((item) => item.text.startsWith("Confirm"));
    const promoteTarget = listed.body.items.find((item) => item.text.startsWith("Promote"));
    if (!confirmTarget || !promoteTarget) throw new Error("Expected both autonomous decisions in the inbox.");
    const confirmed = await requestJson<{ outcome: string; decision: { reviewStatus: string } }>(
      baseUrl,
      `/api/session-decisions/${confirmTarget.id}/review`,
      { method: "PATCH", body: { projectRoot: root, reviewStatus: "confirmed" } },
    );
    expect(confirmed).toMatchObject({
      status: 200,
      body: { outcome: "session_decision_reviewed", decision: { reviewStatus: "confirmed" } },
    });

    const knowledge = await requestJson<{ outcome: string; knowledge: { id: string } }>(baseUrl, "/api/knowledge", {
      method: "POST",
      body: {
        projectRoot: root,
        idempotencyKey: "api-session-decision-knowledge",
        kind: "decision",
        title: "Promoted API decision",
        body: "The Agent choice is preserved as reusable project Knowledge.",
        sessionId: finalized.session.id,
      },
    });
    expect(knowledge.body.outcome).toBe("knowledge_recorded");
    const promoted = await requestJson<{
      outcome: string;
      decision: { reviewStatus: string; knowledgeId: string };
    }>(baseUrl, `/api/session-decisions/${promoteTarget.id}/review`, {
      method: "PATCH",
      body: { projectRoot: root, reviewStatus: "promoted", knowledgeId: knowledge.body.knowledge.id },
    });
    expect(promoted).toMatchObject({
      status: 200,
      body: {
        outcome: "session_decision_reviewed",
        decision: { reviewStatus: "promoted", knowledgeId: knowledge.body.knowledge.id },
      },
    });
    const pending = await requestJson<{ pendingCount: number; items: unknown[] }>(
      baseUrl,
      `/api/session-decisions?projectRoot=${encodeURIComponent(root)}`,
    );
    expect(pending.body).toEqual({ outcome: "session_decisions", items: [], pendingCount: 0 });
  });

  it("lists, requests, edits, and versions standing Knowledge pages through the Web API", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-knowledge-pages-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Knowledge page API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-knowledge-pages",
      title: "Knowledge page API fixture",
      summary: "Source for the page.",
      workSummary: { outcomes: ["Page source."], scope: [], decisions: [], verification: [], nextSteps: [] },
      completedAt: "2026-09-26T12:00:00.000Z",
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected the API fixture Session to finalize.");

    const requested = await requestJson<{ outcome: string; page: { id: string; status: string } }>(
      baseUrl,
      "/api/knowledge-pages/update-requests",
      { method: "POST", body: { projectRoot: root, slug: "architecture" } },
    );
    expect(requested.body).toMatchObject({ outcome: "knowledge_page_update_requested", page: { status: "empty" } });
    const invalid = await requestJson(baseUrl, "/api/knowledge-pages/update-requests", {
      method: "POST",
      body: { projectRoot: root, slug: "Not A Slug" },
    });
    expect(invalid.status).toBe(400);

    const pageId = requested.body.page.id;
    const edited = await requestJson(baseUrl, `/api/knowledge-pages/${pageId}`, {
      method: "PATCH",
      body: {
        sections: [{ heading: "Layout", content: "Hand-written.", sourceSessionIds: [finalized.session.id] }],
      },
    });
    expect(edited.body).toMatchObject({ outcome: "knowledge_page_updated", page: { version: 1, lastAuthor: "web" } });
    const unsourced = await requestJson(baseUrl, `/api/knowledge-pages/${pageId}`, {
      method: "PATCH",
      body: { sections: [{ heading: "Layout", content: "No source.", sourceSessionIds: [] }] },
    });
    expect(unsourced.status).toBe(400);

    const listed = await requestJson<{ items: Array<{ slug: string; version: number }> }>(
      baseUrl,
      `/api/knowledge-pages?projectRoot=${encodeURIComponent(root)}`,
    );
    expect(listed.body.items).toEqual([expect.objectContaining({ slug: "architecture", version: 1 })]);
    const versions = await requestJson(baseUrl, `/api/knowledge-pages/${pageId}/versions`);
    expect(versions.body).toMatchObject({
      outcome: "knowledge_page_versions",
      versions: [{ version: 1, author: "web" }],
    });
    const missing = await requestJson(baseUrl, "/api/knowledge-pages/no-such-page/versions");
    expect(missing.body).toMatchObject({ outcome: "not_found" });
  });

  it("serves hotspots with validated filters", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-hotspots-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Hotspot API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    for (const key of ["one", "two"]) {
      store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `api-hotspot-${key}`,
        title: `Hotspot ${key}`,
        summary: "Changed the same file.",
        changedFiles: ["src/Hive.ts"],
        verification: { status: key === "one" ? "failed" : "passed" },
        completedAt: "2026-09-26T12:00:00.000Z",
      });
    }

    const listed = await requestJson<{ outcome: string; items: Array<{ path: string; sessionCount: number }> }>(
      baseUrl,
      `/api/insights/hotspots?projectId=${project.id}&groupBy=file&from=2026-09-01&limit=5`,
    );
    expect(listed.body).toMatchObject({
      outcome: "hotspots",
      items: [{ path: "src/Hive.ts", sessionCount: 2, failedCount: 1 }],
    });
    const invalid = await requestJson(baseUrl, "/api/insights/hotspots?groupBy=folder");
    expect(invalid.status).toBe(400);
    const reversed = await requestJson(baseUrl, "/api/insights/hotspots?from=2026-09-30&to=2026-09-01");
    expect(reversed.status).toBe(400);
  });

  it("serves derived graph edges on request and explains graph paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-graph-path-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Graph path API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const sessionIds: string[] = [];
    for (const key of ["one", "two", "three"]) {
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `api-graph-path-${key}`,
        title: `Graph ${key}`,
        summary: "Changed two files together.",
        changedFiles: ["src/a.ts", "src/b.ts"],
        verification: { status: "passed" },
      });
      if (result.outcome === "finalized") sessionIds.push(result.session.id);
    }

    const plain = await requestJson<{ edges: Array<{ kind: string }> }>(baseUrl, `/api/graph?projectId=${project.id}`);
    expect(plain.body.edges.some((edge) => edge.kind === "co_changed")).toBe(false);
    const derived = await requestJson<{ edges: Array<{ kind: string; provenance: string }> }>(
      baseUrl,
      `/api/graph?projectId=${project.id}&includeDerived=true`,
    );
    expect(derived.body.edges.filter((edge) => edge.kind === "co_changed")).toEqual([
      expect.objectContaining({ provenance: "derived" }),
    ]);

    const path = await requestJson<{ outcome: string; found: boolean; steps: unknown[] }>(
      baseUrl,
      `/api/graph/path?projectId=${project.id}&from=${encodeURIComponent(`file:${project.id}:src/a.ts`)}&to=${encodeURIComponent(`file:${project.id}:src/b.ts`)}&includeDerived=true`,
    );
    expect(path.body).toMatchObject({ outcome: "graph_path", found: true, steps: [expect.anything()] });
    const invalid = await requestJson(baseUrl, "/api/graph/path?from=&to=x");
    expect(invalid.status).toBe(400);
  });

  it("serves the timeline and rejects ranges over a year", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-timeline-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Timeline API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-timeline",
      title: "Timeline fixture",
      summary: "One Session on the timeline.",
      verification: { status: "passed" },
      completedAt: "2026-09-10T12:00:00.000Z",
    });

    const timeline = await requestJson<{ outcome: string; sessions: Array<{ title: string }> }>(
      baseUrl,
      `/api/insights/timeline?projectId=${project.id}&from=2026-09-01&to=2026-09-30`,
    );
    expect(timeline.body).toMatchObject({ outcome: "timeline", sessions: [{ title: "Timeline fixture" }] });
    const tooLong = await requestJson(baseUrl, "/api/insights/timeline?from=2025-01-01&to=2026-09-30");
    expect(tooLong.status).toBe(400);
  });

  it("voids and restores a diagram through the Web API and requires a reason to void", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-diagram-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Diagram API fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "api-diagram",
      title: "Diagram fixture",
      summary: "Has a diagram.",
      verification: { status: "passed" },
      diagrams: [{ title: "Flow", source: "flowchart LR\n  A --> B" }],
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected finalize");
    const [diagram] = store.getSessionDetail(finalized.session.id)!.diagrams;

    const missingReason = await requestJson(baseUrl, `/api/diagrams/${diagram!.id}/void`, {
      method: "PATCH",
      body: { voided: true },
    });
    expect(missingReason.status).toBe(400);
    const voided = await requestJson(baseUrl, `/api/diagrams/${diagram!.id}/void`, {
      method: "PATCH",
      body: { voided: true, reason: "Wrong diagram." },
    });
    expect(voided.body).toMatchObject({
      outcome: "diagram_void_updated",
      diagram: { voided: { reason: "Wrong diagram." } },
    });
    const detail = await requestJson<{ diagrams: Array<{ voided?: unknown }> }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}`,
    );
    expect(detail.body.diagrams[0]?.voided).toBeDefined();
  });

  it("validates project deletion names, requires a disk backup, and returns a safe backup file name", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-project-delete-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const emptyAudits = await requestJson<unknown[]>(baseUrl, "/api/project-deletion-audits");
    expect(emptyAudits.status).toBe(200);
    expect(emptyAudits.body).toEqual([]);
    const project = store.addProject("API Delete Fixture", join(root, "workspace"));

    const invalid = await requestJson<{ error: string; code: string }>(baseUrl, `/api/projects/${project.id}`, {
      method: "DELETE",
      body: { confirmationName: " " },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("Invalid project deletion confirmation.");
    expect(invalid.body.code).toBe("invalid_project_deletion_confirmation");

    const mismatch = await requestJson<{ error: string; code: string }>(baseUrl, `/api/projects/${project.id}`, {
      method: "DELETE",
      body: { confirmationName: "Wrong name" },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe("The confirmation name does not match the project name.");
    expect(mismatch.body.code).toBe("PROJECT_NAME_MISMATCH");
    expect(store.getProjectById(project.id)).toBeDefined();

    const deleted = await requestJson<{
      outcome: string;
      projectId: string;
      deletedAt: string;
      backupFileName: string;
      deletedCounts: { projects: number };
    }>(baseUrl, `/api/projects/${project.id}`, {
      method: "DELETE",
      body: { confirmationName: project.name },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      outcome: "project_deleted",
      backupFileName: expect.stringMatching(/pre-delete-.*\.sqlite$/),
      deletedCounts: { projects: 1 },
    });
    expect(existsSync(join(root, "backups", deleted.body.backupFileName))).toBe(true);
    expect(store.getProjectById(project.id)).toBeUndefined();

    const audits = await requestJson<
      Array<{ deletedAt: string; projectId: string; deletedCounts: { projects: number } }>
    >(baseUrl, "/api/project-deletion-audits");
    expect(audits.status).toBe(200);
    expect(audits.body).toHaveLength(1);
    expect(audits.body[0]).toMatchObject({
      deletedAt: deleted.body.deletedAt,
      projectId: project.id,
      deletedCounts: { projects: 1 },
    });
    expect(Object.keys(audits.body[0] ?? {}).sort()).toEqual(["deletedAt", "deletedCounts", "projectId"]);
    expect(JSON.stringify(audits.body)).not.toContain(project.name);
    expect(JSON.stringify(audits.body)).not.toContain(project.rootPath);
    const attemptedWrite = await requestJson<{ error: string }>(baseUrl, "/api/project-deletion-audits", {
      method: "POST",
      body: {},
    });
    expect(attemptedWrite.status).toBe(404);
  });

  it("returns an explicit safe failure when in-memory databases cannot be backed up", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-project-delete-memory-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Memory Delete Fixture", join(root, "workspace"));

    const result = await requestJson<{ error: string; code: string }>(baseUrl, `/api/projects/${project.id}`, {
      method: "DELETE",
      body: { confirmationName: project.name },
    });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe(
      "The required pre-deletion backup could not be created; the project was not deleted.",
    );
    expect(result.body.code).toBe("PROJECT_BACKUP_FAILED");
    expect(store.getProjectById(project.id)).toBeDefined();
  });

  it("does not expose SQLite details when the project deletion transaction rolls back", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-project-delete-rollback-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });
    const project = store.addProject("Rollback API Fixture", join(root, "workspace"));
    const sabotage = new DatabaseSync(databasePath);
    try {
      sabotage.exec(
        `CREATE TRIGGER reject_api_fixture_delete BEFORE DELETE ON projects
         WHEN OLD.id = '${project.id}'
         BEGIN SELECT RAISE(ABORT, 'private SQLite detail'); END;`,
      );
    } finally {
      sabotage.close();
    }

    const result = await requestJson<{ error: string; code: string }>(baseUrl, `/api/projects/${project.id}`, {
      method: "DELETE",
      body: { confirmationName: project.name },
    });
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("Project deletion failed; the pre-deletion backup is preserved.");
    expect(result.body.code).toBe("PROJECT_DELETE_FAILED");
    expect(result.body.error).not.toContain("private SQLite detail");
    expect(store.getProjectById(project.id)).toBeDefined();
  });

  it("lists and creates backups and exports the database without exposing paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-backup-test-"));
    const store = new WorkIntelligenceStore(join(root, "work-intelligence.sqlite"));
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    expect(await requestJson(baseUrl, "/api/backups")).toMatchObject({
      status: 200,
      body: { outcome: "database_backups", backups: [] },
    });
    const created = await requestJson<{ created: { fileName: string } }>(baseUrl, "/api/backups", {
      method: "POST",
      body: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.created.fileName).toMatch(/^work-intelligence-manual-\d{8}T\d{6}Z\.sqlite$/);
    expect(JSON.stringify(created.body)).not.toContain(root);

    const invalidDeleteBody = await requestJson<{ error: string }>(
      baseUrl,
      `/api/backups/${created.body.created.fileName}`,
      {
        method: "DELETE",
        body: { path: "../outside.sqlite" },
      },
    );
    expect(invalidDeleteBody.status).toBe(400);
    expect(invalidDeleteBody.body.error).toBe("刪除備份請求無效。");

    const traversalDelete = await requestJson<{ error: string }>(baseUrl, "/api/backups/%2E%2E%2Fsecret.sqlite", {
      method: "DELETE",
      body: {},
    });
    expect(traversalDelete.status).toBe(400);
    expect(traversalDelete.body.error).toBe("備份檔名無效。");

    const formDelete = await fetch(`${baseUrl}/api/backups/${encodeURIComponent(created.body.created.fileName)}`, {
      method: "DELETE",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=yes",
    });
    expect(formDelete.status).toBe(415);

    const deleted = await requestJson<{ outcome: string; deleted: { fileName: string }; backups: unknown[] }>(
      baseUrl,
      `/api/backups/${encodeURIComponent(created.body.created.fileName)}`,
      { method: "DELETE", body: {} },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ outcome: "backup_deleted", deleted: created.body.created, backups: [] });
    expect(JSON.stringify(deleted.body)).not.toContain(root);
    expect(
      await requestJson<{ error: string }>(
        baseUrl,
        `/api/backups/${encodeURIComponent(created.body.created.fileName)}`,
        {
          method: "DELETE",
          body: {},
        },
      ),
    ).toMatchObject({ status: 404, body: { error: "找不到這份備份。" } });

    // A cross-site form post cannot send JSON, so it cannot trigger a backup or an export.
    const formPost = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(formPost.status).toBe(415);

    const exported = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toMatch(/attachment; filename="work-intelligence-export-/);
    const bytes = Buffer.from(await exported.arrayBuffer());
    expect(bytes.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");

    const portable = await requestJson<{ format: string; scope: { type: string }; tables: { projects: unknown[] } }>(
      baseUrl,
      "/api/export",
      { method: "POST", body: { scope: "all" } },
    );
    expect(portable.status).toBe(200);
    expect(portable.body).toMatchObject({
      format: "work-intelligence-export",
      scope: { type: "all" },
      tables: { projects: [] },
    });

    const missingProject = await requestJson<{ error: string; code: string }>(baseUrl, "/api/export", {
      method: "POST",
      body: { scope: "project", projectId: "missing-project" },
    });
    expect(missingProject.status).toBe(404);
    expect(missingProject.body.error).toContain("找不到要匯出的專案");
    expect(missingProject.body.code).toBe("project_not_found");
  });

  it("previews and merges portable project data while the server is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-project-transfer-"));
    const projectRoot = join(root, "path-must-not-be-created");
    const remappedProjectRoot = join(root, "remapped-project-path");
    const source = new WorkIntelligenceStore(":memory:");
    const project = source.addProject("Portable API fixture", projectRoot);
    source.updateProject(project.id, { status: "tracked" });
    const finalized = source.finalizeSession({
      projectRoot,
      idempotencyKey: "portable-api-session",
      title: "可攜式匯入 API 測試",
      summary: "確認 API 預覽和匯入可在服務執行時完成。",
      completedAt: "2026-09-25T10:00:00.000Z",
    });
    if (finalized.outcome !== "finalized") {
      throw new Error(`Expected a finalized source Session, got ${finalized.outcome}.`);
    }
    const bundle = source.exportProjectData({ type: "project", projectId: project.id });
    const destination = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(destination);
    resources.push({ server, store: destination, root });

    try {
      const preview = await requestJson<{
        outcome: string;
        additions: { projects: number; sessions: number };
        selectedProjects: Array<{ name: string; rootPath: string; resolution: string }>;
      }>(baseUrl, "/api/import/preview", {
        method: "POST",
        body: { bundle, remap: [{ from: projectRoot, to: remappedProjectRoot }] },
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        outcome: "project_data_import_preview",
        additions: { projects: 1, sessions: 1 },
        selectedProjects: [{ name: "Portable API fixture", rootPath: remappedProjectRoot, resolution: "new" }],
      });
      expect(JSON.stringify(preview.body)).not.toContain(`"rootPath":"${projectRoot}"`);

      const unsupportedSchema = await requestJson<{ error: string; code: string }>(baseUrl, "/api/import/preview", {
        method: "POST",
        body: { bundle: { ...bundle, schemaVersion: bundle.schemaVersion + 1 } },
      });
      expect(unsupportedSchema.status).toBe(400);
      expect(unsupportedSchema.body.error).toContain("schema 版本");
      expect(unsupportedSchema.body.code).toBe("unsupported_schema");

      const invalidBundle = await requestJson<{ error: string; code: string }>(baseUrl, "/api/import/preview", {
        method: "POST",
        body: { bundle, projectId: "missing-project" },
      });
      expect(invalidBundle.status).toBe(400);
      expect(invalidBundle.body.code).toBe("invalid_bundle");

      const rejectedOrigin = await fetch(`${baseUrl}/api/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ bundle }),
      });
      expect(rejectedOrigin.status).toBe(403);

      const imported = await requestJson<{ outcome: string; additions: { projects: number; sessions: number } }>(
        baseUrl,
        "/api/import",
        { method: "POST", body: { bundle, remap: [{ from: projectRoot, to: remappedProjectRoot }] } },
      );
      expect(imported.status).toBe(200);
      expect(imported.body).toMatchObject({
        outcome: "project_data_imported",
        additions: { projects: 1, sessions: 1 },
      });
      expect(destination.listProjects().find((item) => item.id === project.id)?.status).toBe("paused");
      expect(destination.getSessionById(finalized.session.id)?.summary).toBe(finalized.session.summary);
      expect(existsSync(projectRoot)).toBe(false);

      const repeated = await requestJson<{ skipped: { projects: number; sessions: number } }>(
        baseUrl,
        "/api/import/preview",
        { method: "POST", body: { bundle, remap: [{ from: projectRoot, to: remappedProjectRoot }] } },
      );
      expect(repeated.status).toBe(200);
      expect(repeated.body.skipped).toMatchObject({ projects: 1, sessions: 1 });

      // Import routes have their own 50 MiB limit; other JSON routes keep the smaller default.
      const largerThanDefault = await fetch(`${baseUrl}/api/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_600_000) }),
      });
      expect(largerThanDefault.status).toBe(400);

      const tooLarge = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(50 * 1024 * 1024 + 1, 0x20),
      });
      expect(tooLarge.status).toBe(413);
    } finally {
      source.close();
    }
  }, 30_000);

  it("returns a fixed 500 response when project-data storage throws an internal error", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    const bundle = store.exportProjectData({ type: "all" });
    const internalMessage = "UNIQUE constraint failed: sessions.idempotency_key";
    store.previewProjectDataImport = () => {
      throw new Error(internalMessage);
    };
    store.importProjectData = () => {
      throw new Error(internalMessage);
    };
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root: mkdtempSync(join(tmpdir(), "work-intelligence-api-transfer-error-")) });

    for (const path of ["/api/import/preview", "/api/import"]) {
      const result = await requestJson<{ error: string; code: string }>(baseUrl, path, {
        method: "POST",
        body: { bundle },
      });
      expect(result.status).toBe(500);
      expect(result.body.error).toBe("Internal server error.");
      expect(result.body.code).toBe("internal_error");
      expect(JSON.stringify(result.body)).not.toContain(internalMessage);
    }
  });

  it("reports that an in-memory database has no backups", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root: mkdtempSync(join(tmpdir(), "work-intelligence-api-backup-memory-")) });
    expect(await requestJson(baseUrl, "/api/backups")).toMatchObject({
      status: 409,
      body: {
        outcome: "backup_unavailable",
        code: "backup_unavailable",
        error: "An in-memory database cannot be backed up.",
      },
    });
  });

  it("returns the folder chosen in the native dialog, only for JSON posts", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    let opened = 0;
    const server = createServer(
      createApiHandler(store, {
        pickFolder: async () => {
          opened += 1;
          return { outcome: "folder_picked", path: "/Users/me/apiary", name: "apiary" };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    resources.push({ server, store, root: mkdtempSync(join(tmpdir(), "work-intelligence-api-pick-")) });

    const formPost = await fetch(`${baseUrl}/api/system/pick-folder`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect(formPost.status).toBe(415);
    expect(opened).toBe(0);
    expect(await requestJson(baseUrl, "/api/system/pick-folder", { method: "POST", body: {} })).toMatchObject({
      status: 200,
      body: { outcome: "folder_picked", path: "/Users/me/apiary", name: "apiary" },
    });
  });

  it("checks import folders with stat only and safely reassigns a tracked project location", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-project-location-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const oldProjectRoot = canonicalizeProjectRoot(join(root, "old-project-location"));
    const newProjectRoot = canonicalizeProjectRoot(join(root, "new-project-location"));
    const importTarget = canonicalizeProjectRoot(join(root, "portable-project-location"));
    mkdirSync(newProjectRoot);
    mkdirSync(importTarget);
    const sentinel = "folder-content-must-not-be-read-or-returned";
    writeFileSync(join(importTarget, "sentinel.txt"), sentinel, "utf8");

    const store = new WorkIntelligenceStore(databasePath);
    const project = store.addProject("Location API fixture", oldProjectRoot);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: oldProjectRoot,
      idempotencyKey: "api-location-fixture-session",
      title: "位置 API 測試記錄",
      summary: "驗證改位置需要同意並同步移動 handoff 路徑。",
      handoffPath: join(oldProjectRoot, "handoff.md"),
      handoffContent: "Synthetic location handoff.",
      completedAt: "2026-09-27T01:10:00.000Z",
    });
    expect(finalized.outcome).toBe("finalized");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const denied = await requestJson<{ code: string }>(baseUrl, `/api/projects/${project.id}/location`, {
      method: "PATCH",
      body: { rootPath: newProjectRoot },
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe("project_location_confirmation_required");
    expect(store.getProjectById(project.id)?.rootPath).toBe(oldProjectRoot);

    const invalid = await requestJson<{ code: string }>(baseUrl, `/api/projects/${project.id}/location`, {
      method: "PATCH",
      body: { rootPath: join(root, "missing-folder"), confirmedTrackedScope: true },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("project_location_invalid");

    const moved = await requestJson<{ id: string; rootPath: string }>(baseUrl, `/api/projects/${project.id}/location`, {
      method: "PATCH",
      body: { rootPath: newProjectRoot, confirmedTrackedScope: true },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: project.id, rootPath: newProjectRoot });
    expect(
      await requestJson<Array<{ id: string; rootPath: string; folderStatus: string }>>(baseUrl, "/api/projects"),
    ).toMatchObject({
      status: 200,
      body: [{ id: project.id, rootPath: newProjectRoot, folderStatus: "found" }],
    });

    const source = new WorkIntelligenceStore(":memory:");
    try {
      const sourceProject = source.addProject(
        "Portable location fixture",
        canonicalizeProjectRoot(join(root, "old-portable-root")),
      );
      const bundle = source.exportProjectData({ type: "project", projectId: sourceProject.id });
      const preview = await requestJson<{
        selectedProjects: Array<{ sourceRootPath: string; rootPath: string; folderStatus: string }>;
      }>(baseUrl, "/api/import/preview", {
        method: "POST",
        body: { bundle, remap: [{ from: sourceProject.rootPath, to: importTarget }] },
      });
      expect(preview.status).toBe(200);
      expect(preview.body.selectedProjects).toMatchObject([
        {
          sourceRootPath: sourceProject.rootPath,
          rootPath: importTarget,
          folderStatus: "found",
        },
      ]);
      expect(JSON.stringify(preview.body)).not.toContain(sentinel);
    } finally {
      source.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      expect(db.prepare("SELECT source_path FROM raw_snapshots WHERE project_id = ?").get(project.id)).toEqual({
        source_path: join(newProjectRoot, "handoff.md"),
      });
    } finally {
      db.close();
    }
  });
});

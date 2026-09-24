import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { createApiHandler } from "./server.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

async function startApi(store: WorkIntelligenceStore): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createApiHandler(store));
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
    expect(await rejected.json()).toMatchObject({ error: "Origin is not allowed." });

    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: "http://127.0.0.1:5966" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5966");
    expect(await allowed.json()).toMatchObject({ ok: true, database: "connected" });
  });

  it("rejects non-loopback Host headers so DNS-rebound pages cannot read the API", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root: mkdtempSync(join(tmpdir(), "work-intelligence-api-host-test-")) });
    const { port } = new URL(baseUrl);

    const statusForHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          { host: "127.0.0.1", port, path: "/api/sessions", headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.once("error", reject);
        request.end();
      });

    expect(await statusForHost("rebind.evil.example")).toBe(421);
    expect(await statusForHost(`evil.example:${port}`)).toBe(421);
    expect(await statusForHost(`127.0.0.1:${port}`)).toBe(200);
    expect(await statusForHost("localhost:5966")).toBe(200);
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
    expect(await response.json()).toMatchObject({ error: "Invalid JSON request body." });

    const unsupported = await fetch(`${baseUrl}/api/work/finalize`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({}),
    });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({ error: "Content-Type must be application/json." });
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

    const list = await requestJson<{ items: Array<{ title: string }>; pageInfo: { total: number } }>(
      baseUrl,
      "/api/sessions",
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.title)).toEqual(["Visible Session"]);
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
});

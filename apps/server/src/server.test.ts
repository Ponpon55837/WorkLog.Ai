import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

async function requestJson<T>(baseUrl: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, body: await response.json() as T };
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

  it("returns a safe client error for malformed JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-body-test-"));
    const store = new WorkIntelligenceStore(":memory:");
    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const response = await fetch(`${baseUrl}/api/work/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid JSON request body." });

    const unsupported = await fetch(`${baseUrl}/api/work/finalize`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({})
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
      events: [{ type: "verification", summary: "The API update must preserve this event." }]
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized API test session");
    }
    store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "server.test.ts",
      summary: "REST API integration evidence."
    });

    const { server, baseUrl } = await startApi(store);
    resources.push({ server, store, root });

    const update = await requestJson<{ outcome: string; duplicate?: boolean; session?: { id: string; summary: string } }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/summary`,
      {
        method: "PATCH",
        body: {
          idempotencyKey: "api-summary-update-001",
          mode: "append",
          summary: "補充 API 更新同一筆 Session 的主摘要。"
        }
      }
    );
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      outcome: "summary_updated",
      duplicate: false,
      session: {
        id: finalized.session.id,
        summary: "Original API summary.\n\n補充 API 更新同一筆 Session 的主摘要。"
      }
    });

    const retry = await requestJson<{ outcome: string; duplicate?: boolean }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/summary`,
      {
        method: "PATCH",
        body: {
          idempotencyKey: "api-summary-update-001",
          mode: "append",
          summary: "補充 API 更新同一筆 Session 的主摘要。"
        }
      }
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
        verification: { status: "passed" }
      },
      events: [expect.objectContaining({ type: "verification" }), expect.objectContaining({ type: "finalized" })],
      evidence: [expect.objectContaining({ reference: "server.test.ts" })]
    });

    store.updateProject(project.id, { status: "paused" });
    const skipped = await requestJson<{ outcome: string; projectStatus?: string }>(
      baseUrl,
      `/api/sessions/${finalized.session.id}/summary`,
      {
        method: "PATCH",
        body: { idempotencyKey: "api-summary-paused-001", summary: "Must not be written." }
      }
    );
    expect(skipped.body).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });
});

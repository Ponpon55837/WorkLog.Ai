import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";

// Fictional fixtures only.
const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

async function startFixture(): Promise<{ baseUrl: string; store: WorkIntelligenceStore; sessionId: string }> {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-session-lifecycle-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = new WorkIntelligenceStore(join(root, "data", "work-intelligence.sqlite"));
  const project = store.addProject("API Session lifecycle", workspace);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot: workspace,
    idempotencyKey: "api-session-lifecycle",
    title: "Original API title",
    summary: "Synthetic API lifecycle summary.",
    changedFiles: [],
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") {
    throw new Error("Expected a finalized API test Session");
  }
  const server = createServer(createApiHandler(store));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  resources.push({ server, store, root });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test API did not expose a TCP address.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, store, sessionId: finalized.session.id };
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

describe("Session title and permanent deletion API", () => {
  it("renames a Session in place and rejects an empty title", async () => {
    const { baseUrl, sessionId } = await startFixture();

    const renamed = await requestJson<{ outcome: string; previousTitle: string; session: { title: string } }>(
      baseUrl,
      `/api/sessions/${sessionId}/title`,
      { method: "PATCH", body: { title: "Corrected API title" } },
    );
    expect(renamed).toMatchObject({
      status: 200,
      body: {
        outcome: "title_updated",
        previousTitle: "Original API title",
        session: { title: "Corrected API title" },
      },
    });

    const empty = await requestJson<{ error: string }>(baseUrl, `/api/sessions/${sessionId}/title`, {
      method: "PATCH",
      body: { title: "   " },
    });
    expect(empty.status).toBe(400);
  });

  it("deletes only a voided Session, only with a JSON confirmation, and reports coded errors", async () => {
    const { baseUrl, store, sessionId } = await startFixture();

    const formDelete = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=true",
    });
    expect(formDelete.status).toBe(415);

    const unconfirmed = await requestJson<{ error: string }>(baseUrl, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      body: {},
    });
    expect(unconfirmed.status).toBe(400);

    const active = await requestJson<{ code: string }>(baseUrl, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      body: { confirm: true },
    });
    expect(active).toMatchObject({ status: 409, body: { code: "SESSION_NOT_VOIDED" } });

    store.setSessionVoid({ sessionId, voided: true, reason: "Recorded as a test." });
    const deleted = await requestJson<{ outcome: string; backupFileName: string }>(
      baseUrl,
      `/api/sessions/${sessionId}`,
      { method: "DELETE", body: { confirm: true } },
    );
    expect(deleted).toMatchObject({ status: 200, body: { outcome: "session_deleted" } });
    expect(deleted.body.backupFileName).toMatch(/^work-intelligence-pre-session-delete-\d{8}T\d{6}Z\.sqlite$/);

    expect((await requestJson(baseUrl, `/api/sessions/${sessionId}`)).status).toBe(404);
    const again = await requestJson<{ code: string }>(baseUrl, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      body: { confirm: true },
    });
    expect(again).toMatchObject({ status: 404, body: { code: "SESSION_NOT_FOUND" } });
  });
});

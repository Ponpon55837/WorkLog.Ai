import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { createApiHandler } from "../../apps/server/src/server.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wi-attention-api-"));
  const projectRoot = join(root, "fictional");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Fictional orchard", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  store.finalizeSession({
    projectRoot,
    idempotencyKey: "source",
    title: "Fictional result",
    summary: "Saved work.",
    changedFiles: [],
    verification: { status: "passed" },
    workSummary: {
      outcomes: [],
      scope: [],
      decisions: [{ text: "Verify source evidence", origin: "agent_autonomous" }],
      verification: [],
      nextSteps: [],
    },
  });
  const server = createServer(createApiHandler(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, store, root });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return { store, project, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe("related work REST boundary", () => {
  it("validates input, gates inactive sources and keeps Origins enforced", async () => {
    const { baseUrl, store, project } = await setup();
    const id = store.listSessionsPage({ projectId: project.id }).items[0]!.id;
    expect((await fetch(`${baseUrl}/api/sessions/${id}/related?extra=bad`)).status).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/sessions/${id}/related`, { headers: { origin: "https://untrusted.example" } }))
        .status,
    ).toBe(403);
    expect(await (await fetch(`${baseUrl}/api/sessions/${id}/related`)).json()).toMatchObject({
      outcome: "related_work",
      reason: "no_files",
      items: [],
    });
    store.updateProject(project.id, { status: "paused" });
    const hidden = await (await fetch(`${baseUrl}/api/sessions/${id}/related`)).json();
    expect(hidden).toMatchObject({ state: "unavailable", reason: "source_unavailable", items: [] });
    expect(JSON.stringify(hidden)).not.toContain("Fictional result");
  });
  it("masks unexpected lookup failures", async () => {
    const { baseUrl, store } = await setup();
    vi.spyOn(store, "getRelatedWork").mockImplementation(() => {
      throw new Error("Private fixture path");
    });
    const response = await fetch(`${baseUrl}/api/sessions/fixture/related`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error.", code: "internal_error" });
  });
});

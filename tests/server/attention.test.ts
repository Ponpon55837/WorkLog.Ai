import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionPreferenceError } from "../../packages/storage/src/attention-service.js";
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

describe("attention REST boundary", () => {
  it("validates scopes, bounds and unknown input before reading", async () => {
    const { baseUrl, store, project } = await setup();
    const read = vi.spyOn(store, "getAttention");
    for (const query of ["kind=script", "page=0", "pageSize=51", "page=100001", "extra=secret"]) {
      const response = await fetch(`${baseUrl}/api/attention?${query}`);
      expect(response.status).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
    const response = await fetch(`${baseUrl}/api/attention?projectId=${project.id}&kind=decision&page=1&pageSize=10`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: "attention",
      total: 1,
      items: [{ kind: "decision", projectId: project.id }],
    });
    store.updateProject(project.id, { status: "paused" });
    const skipped = await fetch(`${baseUrl}/api/attention?projectId=${project.id}`);
    expect(await skipped.json()).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });
  it("keeps the shared origin boundary and masks unexpected aggregate errors", async () => {
    const { baseUrl, store } = await setup();
    const rejected = await fetch(`${baseUrl}/api/attention`, { headers: { origin: "https://untrusted.example" } });
    expect(rejected.status).toBe(403);
    vi.spyOn(store, "getAttention").mockImplementation(() => {
      throw new Error("Private path /fictional/secret.sqlite");
    });
    const response = await fetch(`${baseUrl}/api/attention`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error.", code: "internal_error" });
  });
  it("validates and commits Web display intents, enforcing source and preference CAS", async () => {
    const { baseUrl, store, project } = await setup();
    const result = store.getAttention({ projectId: project.id, kind: "decision" });
    if (result.outcome !== "attention") throw new Error("Missing fixture attention");
    const item = result.items[0]!;
    const input = {
      projectId: project.id,
      kind: item.kind,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision,
      expectedRevision: 0,
      action: "hide",
    };
    const write = vi.spyOn(store, "updateAttentionPreference");
    const patch = (data: unknown, origin?: string) =>
      fetch(`${baseUrl}/api/attention/preferences`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify(data),
      });
    for (const data of [
      { ...input, expectedRevision: -1 },
      { ...input, action: "resolve" },
      { ...input, sourceRevision: "guess" },
      { ...input, extra: true },
    ])
      expect((await patch(data)).status).toBe(400);
    expect((await patch(input, "https://untrusted.example")).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    expect((await patch(input)).status).toBe(200);
    expect((await patch(input)).status).toBe(409);
    const visible = await (await fetch(`${baseUrl}/api/attention?projectId=${project.id}&kind=decision`)).json();
    expect(visible).toMatchObject({ total: 1, minimumTotal: 1, suppressedCount: 1, items: [] });
    const hidden = await (
      await fetch(`${baseUrl}/api/attention?projectId=${project.id}&kind=decision&view=suppressed`)
    ).json();
    expect(hidden).toMatchObject({ items: [{ preference: { revision: 1, state: "hidden" } }] });
    write.mockImplementation(() => {
      throw new AttentionPreferenceError("not_found");
    });
    expect((await patch(input)).status).toBe(404);
    write.mockImplementation(() => {
      throw new Error("Private /secret/db.sqlite");
    });
    expect(await (await patch(input)).json()).toEqual({ code: "internal_error", error: "Internal server error." });
    write.mockRestore();
    store.updateProject(project.id, { status: "paused" });
    expect(await (await patch(input)).json()).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });
});

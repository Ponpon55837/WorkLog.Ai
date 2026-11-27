import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_CONVENTION_LIMIT } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

async function startFixture() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-convention-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Convention API fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const ids = Array.from({ length: KNOWLEDGE_CONVENTION_LIMIT + 1 }, (_, index) => {
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `rule-${index}`,
      kind: "pattern",
      title: `Rule ${index}`,
      body: `Rule body ${index}.`,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge.id;
  });
  const server = createServer(createApiHandler(store));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  resources.push({ server, store, root });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, store, root, ids };
}

async function put(baseUrl: string, id: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}/api/knowledge/${id}/convention`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe("PUT /api/knowledge/:knowledgeId/convention", () => {
  it("marks and unmarks a convention and shows it in the list and the filtered list", async () => {
    const { baseUrl, root, ids } = await startFixture();

    const marked = await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: true });
    expect(marked).toMatchObject({
      status: 200,
      body: { outcome: "knowledge_updated", conventionCount: 1, knowledge: { id: ids[0] } },
    });
    expect(marked.body.knowledge.conventionConfirmedAt).toEqual(expect.any(String));

    const only = await (await fetch(`${baseUrl}/api/knowledge?convention=true`)).json();
    expect(only.items.map((item: { id: string }) => item.id)).toEqual([ids[0]]);
    const all = await (await fetch(`${baseUrl}/api/knowledge`)).json();
    expect(all.items).toHaveLength(KNOWLEDGE_CONVENTION_LIMIT + 1);

    const unmarked = await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: false });
    expect(unmarked.body).toMatchObject({ outcome: "knowledge_updated", conventionCount: 0 });
    expect(unmarked.body.knowledge.conventionWithdrawal).toMatchObject({ by: "user", reason: "unmarked" });
  });

  it("answers 409 convention_limit_reached beyond five", async () => {
    const { baseUrl, root, ids } = await startFixture();
    for (const id of ids.slice(0, KNOWLEDGE_CONVENTION_LIMIT)) {
      expect((await put(baseUrl, id, { projectRoot: root, confirmed: true })).status).toBe(200);
    }
    expect(await put(baseUrl, ids.at(-1)!, { projectRoot: root, confirmed: true })).toMatchObject({
      status: 409,
      body: { code: "convention_limit_reached", details: { reason: "convention_limit_reached" } },
    });
  });

  it("answers 409 conflict for archived Knowledge and quietly for a missing one", async () => {
    const { baseUrl, store, root, ids } = await startFixture();
    store.updateKnowledge({ projectRoot: root, knowledgeId: ids[0]!, status: "archived" }, "user");
    expect(await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: true })).toMatchObject({
      status: 409,
      body: { code: "conflict", details: { reason: "not_active" } },
    });
    expect(await put(baseUrl, "missing", { projectRoot: root, confirmed: true })).toMatchObject({
      status: 200,
      body: { outcome: "not_found" },
    });
  });

  it("rejects invalid bodies and skips an untracked project", async () => {
    const { baseUrl, store, root, ids } = await startFixture();
    expect((await put(baseUrl, ids[0]!, { projectRoot: root })).status).toBe(400);
    expect((await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: "yes" })).status).toBe(400);
    store.updateProject(store.listProjects()[0]!.id, { status: "paused" });
    expect(await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: true })).toMatchObject({
      status: 200,
      body: { outcome: "skipped" },
    });
  });

  it("keeps the flag when the user edits the title through PATCH and clears it on archive", async () => {
    const { baseUrl, root, ids } = await startFixture();
    await put(baseUrl, ids[0]!, { projectRoot: root, confirmed: true });
    const patch = (body: unknown) =>
      fetch(`${baseUrl}/api/knowledge/${ids[0]}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: root, ...(body as object) }),
      }).then((response) => response.json());

    const edited = await patch({ title: "Retitled by the user" });
    expect(edited.knowledge.conventionConfirmedAt).toEqual(expect.any(String));
    const archived = await patch({ status: "archived" });
    expect(archived.knowledge.conventionConfirmedAt).toBeUndefined();
    expect(archived.knowledge.conventionWithdrawal).toMatchObject({ by: "user", reason: "archived" });
  });
});

import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";

// Fictional fixtures only.
const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

async function startFixture() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-knowledge-page-deletion-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Knowledge page deletion API fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const custom = store.requestKnowledgePageUpdate({
    projectRoot: root,
    slug: "release-process",
    title: "Release process",
    question: "How is a release prepared?",
  });
  const builtIn = store.requestKnowledgePageUpdate({ projectRoot: root, slug: "architecture" });
  if (custom.outcome !== "knowledge_page_update_requested" || builtIn.outcome !== "knowledge_page_update_requested") {
    throw new Error("Expected both fixture pages to be requested.");
  }
  const server = createServer(createApiHandler(store));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  resources.push({ server, store, root });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    root,
    projectId: project.id,
    customPageId: custom.page.id,
    defaultPageId: builtIn.page.id,
  };
}

async function deletePage(
  baseUrl: string,
  pageId: string,
  body: unknown = { confirm: true },
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/knowledge-pages/${pageId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** fetch() cannot set Host, so the Host check goes through node:http. */
function deleteWithHost(port: number, pageId: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "DELETE",
        path: `/api/knowledge-pages/${pageId}`,
        headers: { host, "content-type": "application/json" },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ confirm: true }));
  });
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe("DELETE /api/knowledge-pages/:pageId", () => {
  it("deletes a custom page with a JSON confirmation and reports what went with it", async () => {
    const { baseUrl, store, root, projectId, customPageId } = await startFixture();

    const deleted = await deletePage(baseUrl, customPageId);

    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      outcome: "knowledge_page_deleted",
      pageId: customPageId,
      projectId,
      slug: "release-process",
      deletedCounts: { knowledgePageVersions: 0, attentionPreferences: 0 },
    });
    const listed = store.listKnowledgePages({ projectRoot: root });
    expect(listed.outcome === "knowledge_pages" && listed.items.map((page) => page.slug)).toEqual(["architecture"]);
    expect(await deletePage(baseUrl, customPageId)).toMatchObject({
      status: 404,
      body: { code: "knowledge_page_not_found" },
    });
  });

  it("refuses a default page with its own code and keeps it", async () => {
    const { baseUrl, store, root, defaultPageId } = await startFixture();

    expect(await deletePage(baseUrl, defaultPageId)).toMatchObject({
      status: 409,
      body: { code: "knowledge_page_default", error: "A default Knowledge page cannot be deleted." },
    });
    const listed = store.listKnowledgePages({ projectRoot: root });
    expect(listed.outcome === "knowledge_pages" && listed.items.some((page) => page.id === defaultPageId)).toBe(true);
  });

  it("requires the JSON confirmation and never accepts a form post", async () => {
    const { baseUrl, store, root, customPageId } = await startFixture();

    const form = await fetch(`${baseUrl}/api/knowledge-pages/${customPageId}`, {
      method: "DELETE",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=true",
    });
    expect(form.status).toBe(415);
    expect(await deletePage(baseUrl, customPageId, {})).toMatchObject({ status: 400, body: { code: "invalid_input" } });
    expect(await deletePage(baseUrl, customPageId, { confirm: true, extra: 1 })).toMatchObject({ status: 400 });
    const listed = store.listKnowledgePages({ projectRoot: root });
    expect(listed.outcome === "knowledge_pages" && listed.items).toHaveLength(2);
  });

  it("rejects an untrusted Origin or Host before touching the page", async () => {
    const { baseUrl, port, store, root, customPageId } = await startFixture();

    expect(await deletePage(baseUrl, customPageId, { confirm: true }, { origin: "http://evil.example" })).toMatchObject(
      { status: 403, body: { code: "origin_not_allowed" } },
    );
    const wrongHost = await deleteWithHost(port, customPageId, "evil.example");
    expect(wrongHost.status).toBe(421);
    expect(JSON.parse(wrongHost.body)).toMatchObject({ code: "host_not_allowed" });
    const listed = store.listKnowledgePages({ projectRoot: root });
    expect(listed.outcome === "knowledge_pages" && listed.items).toHaveLength(2);
  });

  it("skips a page whose project is no longer tracked", async () => {
    const { baseUrl, store, projectId, customPageId } = await startFixture();
    store.updateProject(projectId, { status: "paused" });

    expect(await deletePage(baseUrl, customPageId)).toMatchObject({
      status: 200,
      body: { outcome: "skipped", projectStatus: "paused" },
    });
    store.updateProject(projectId, { status: "tracked" });
    expect(await deletePage(baseUrl, customPageId)).toMatchObject({ status: 200 });
  });

  it("masks an unexpected storage failure as internal_error", async () => {
    const { baseUrl, store, customPageId } = await startFixture();
    store.deleteKnowledgePage = () => {
      throw new Error("SQLITE_CORRUPT: /private/path/work-intelligence.sqlite");
    };

    const failed = await deletePage(baseUrl, customPageId);

    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ code: "internal_error" });
    expect(JSON.stringify(failed.body)).not.toContain("/private/path");
  });
});

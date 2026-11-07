import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { ReadWorkerClient, createInlineReadOperations } from "../../apps/server/src/read-worker-client.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(): { databasePath: string; store: WorkIntelligenceStore; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-read-worker-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Read worker fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  for (const [index, file] of ["src/a.ts", "src/b.ts", "src/a.ts"].entries()) {
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `read-worker-session-${index}`,
      title: `Synthetic read Session ${index}`,
      summary: "Used to verify heavy reads on a separate connection.",
      changedFiles: [file],
      verification: { status: "passed" },
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    });
    if (result.outcome !== "finalized") throw new Error("Could not create the synthetic Session.");
  }
  return { databasePath, store, projectId: project.id };
}

async function startApi(handler: ReturnType<typeof createApiHandler>): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

describe("read worker", () => {
  it("returns the same report, Graph, and Hotspots as the API thread", async () => {
    const { databasePath, store } = createFixture();
    const worker = new ReadWorkerClient(databasePath, LATEST_SCHEMA_VERSION);
    try {
      store.syncSearchIndex();
      const date = new Date().toISOString().slice(0, 10);
      expect(await worker.getReport({ period: "year", date })).toEqual(store.getReport({ period: "year", date }));
      expect(await worker.getGraph({ includeDerived: true })).toEqual(store.getGraph({ includeDerived: true }));
      const hotspots = await worker.getHotspots({ limit: 20 });
      expect(hotspots).toEqual(store.getHotspots({ limit: 20 }));
      expect(hotspots.outcome === "hotspots" && hotspots.items[0]?.path).toBe("src/a.ts");
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("serves several concurrent reads and then rejects new work once closed", async () => {
    const { databasePath, store } = createFixture();
    const worker = new ReadWorkerClient(databasePath, LATEST_SCHEMA_VERSION);
    try {
      store.syncSearchIndex();
      const results = await Promise.all([
        worker.getHotspots({ limit: 5 }),
        worker.getHotspots({ limit: 5, groupBy: "directory" }),
        worker.getGraph({}),
      ]);
      expect(results.map((result) => result.outcome)).toEqual(["hotspots", "hotspots", "graph"]);
    } finally {
      await worker.close();
      store.close();
    }
    await expect(worker.getGraph({})).rejects.toThrow(/closing/);
  });

  it("stops an idle worker and starts a fresh one for the next read", async () => {
    const { databasePath, store } = createFixture();
    const worker = new ReadWorkerClient(databasePath, LATEST_SCHEMA_VERSION, { idleTimeoutMs: 25 });
    const workerState = worker as unknown as { lifetime?: { worker: { threadId: number } } };
    try {
      await worker.getGraph({});
      const firstThreadId = workerState.lifetime?.worker.threadId;
      expect(firstThreadId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(workerState.lifetime).toBeUndefined();

      await worker.getGraph({});
      expect(workerState.lifetime?.worker.threadId).not.toBe(firstThreadId);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("refuses a database whose schema is not the required version", async () => {
    const { databasePath, store } = createFixture();
    store.close();
    const old = new DatabaseSync(databasePath);
    undoMigrationsAfter(old, LATEST_SCHEMA_VERSION - 1);
    old.close();
    const worker = new ReadWorkerClient(databasePath, LATEST_SCHEMA_VERSION);
    try {
      await expect(worker.getGraph({})).rejects.toThrow(/schema/);
    } finally {
      await worker.close();
    }
  });

  it("serves the REST routes from the worker and indexes pending documents on the API thread first", async () => {
    const { databasePath, store } = createFixture();
    const worker = new ReadWorkerClient(databasePath, LATEST_SCHEMA_VERSION);
    try {
      // Pending search_dirty rows may only be cleared by a writable connection, never by the read-only worker.
      const writer = new DatabaseSync(databasePath);
      try {
        writer.exec("INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions");
        expect((writer.prepare("SELECT COUNT(*) AS count FROM search_dirty").get() as { count: number }).count).toBe(3);
      } finally {
        writer.close();
      }
      const baseUrl = await startApi(createApiHandler(store, { heavyReads: worker }));

      const hotspots = await fetch(`${baseUrl}/api/insights/hotspots?limit=5`);
      expect(hotspots.status).toBe(200);
      expect(await hotspots.json()).toMatchObject({
        outcome: "hotspots",
        items: [{ path: "src/a.ts", sessionCount: 2 }, { path: "src/b.ts" }],
      });
      const graph = await fetch(`${baseUrl}/api/graph`);
      expect(graph.status).toBe(200);
      expect(await graph.json()).toMatchObject({ outcome: "graph" });
      const report = await fetch(`${baseUrl}/api/reports?period=year&date=${new Date().toISOString().slice(0, 10)}`);
      expect(report.status).toBe(200);
      expect(await report.json()).toMatchObject({ outcome: "report" });
      const invalid = await fetch(`${baseUrl}/api/reports?period=decade`);
      expect(invalid.status).toBe(400);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("keeps the inline fallback equivalent for :memory: databases", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    const inline = createInlineReadOperations(store);
    try {
      expect(await inline.getGraph({})).toEqual(store.getGraph({}));
      expect(await inline.getHotspots({})).toEqual(store.getHotspots({}));
    } finally {
      await inline.close();
      store.close();
    }
  });
});

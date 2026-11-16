import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";

// Fictional fixtures only. A raw connection stands in for a newer release that migrated the shared database.
const SERVER_RESTART_MESSAGE = "資料庫 schema 已更新，請重新啟動 Work Intelligence server。";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function startApiOnTempDatabase(): Promise<{
  baseUrl: string;
  migrateFromAnotherProcess: () => void;
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-api-schema-gate-"));
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const other = new DatabaseSync(databasePath);
  const server: Server = createServer(createApiHandler(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.close();
    other.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    migrateFromAnotherProcess: () => {
      other.exec("BEGIN IMMEDIATE");
      other.exec("CREATE TABLE future_feature (id TEXT PRIMARY KEY)");
      other
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(LATEST_SCHEMA_VERSION + 1, "future_feature", "2030-01-01T00:00:00.000Z");
      other.exec("COMMIT");
    },
  };
}

function postProject(baseUrl: string, name: string, rootPath: string): Promise<Response> {
  return fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, rootPath }),
  });
}

describe("API schema write gate", () => {
  it("accepts writes while the database matches this server's schema", async () => {
    const { baseUrl, root } = await startApiOnTempDatabase();

    expect((await postProject(baseUrl, "Apiary", join(root, "apiary"))).status).toBe(201);
  });

  it("refuses writes with 503 server_restart_required after another process migrated the database", async () => {
    const { baseUrl, root, migrateFromAnotherProcess } = await startApiOnTempDatabase();
    expect((await postProject(baseUrl, "Apiary", join(root, "apiary"))).status).toBe(201);
    migrateFromAnotherProcess();

    const response = await postProject(baseUrl, "Burrow", join(root, "burrow"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: SERVER_RESTART_MESSAGE, code: "server_restart_required" });
  });

  it("keeps reads working and shows that the refused write saved nothing", async () => {
    const { baseUrl, root, migrateFromAnotherProcess } = await startApiOnTempDatabase();
    await postProject(baseUrl, "Apiary", join(root, "apiary"));
    migrateFromAnotherProcess();
    await postProject(baseUrl, "Burrow", join(root, "burrow"));

    const read = await fetch(`${baseUrl}/api/projects`);

    expect(read.status).toBe(200);
    expect(((await read.json()) as Array<{ name: string }>).map((project) => project.name)).toEqual(["Apiary"]);
  });
});

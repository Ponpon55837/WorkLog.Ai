import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { preflightDatabase, type DatabaseIdentity } from "../../apps/server/src/database-preflight.js";
import { startApi, StartApiError, type StartedApi } from "../../apps/server/src/start-api.js";

// In-process startApi on free ports and temp files only. Fictional values only.
const roots: string[] = [];
const servers: Server[] = [];
const apis: StartedApi[] = [];
const previousExitCode = process.exitCode;

async function occupiedPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

async function databaseWith(create: (path: string) => void): Promise<{ path: string; identity: DatabaseIdentity }> {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-start-api-"));
  roots.push(root);
  const path = join(root, "work.sqlite");
  create(path);
  const result = await preflightDatabase(path);
  if (!result.identity) throw new Error("the synthetic database has no identity");
  return { path, identity: result.identity };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const api of apis.splice(0)) await api.shutdown();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe("startApi after a failed listen", () => {
  it("closes everything once: a later shutdown resolves, prints nothing new and leaves the exit code alone", async () => {
    const database = await databaseWith((path) => new WorkIntelligenceStore(path).close());
    const port = await occupiedPort();
    const api = startApi({ database, port, instanceRunId: "synthetic-run-id-0123456789abcdef-lifecycle" });
    apis.push(api);

    await expect(api.listening).rejects.toMatchObject({ kind: "listen", listenCode: "EADDRINUSE" });
    const printed = vi.mocked(console.error).mock.calls.length;
    process.exitCode = undefined;
    await expect(api.shutdown()).resolves.toBeUndefined();
    await expect(api.shutdown()).resolves.toBeUndefined();

    expect(vi.mocked(console.error).mock.calls.length).toBe(printed);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("startApi identity after the store opened", () => {
  it("reports the lineage of an empty file that the first open created", async () => {
    const database = await databaseWith((path) => writeFileSync(path, ""));
    expect(database.identity.lineageId).toBeNull();

    const api = startApi({ database, port: 0 });
    apis.push(api);
    const listening = await api.listening;

    expect(listening.databaseIdentity).toMatchObject({
      realPath: database.identity.realPath,
      fileId: database.identity.fileId,
    });
    expect(listening.databaseIdentity?.lineageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the lineage a database already had", async () => {
    const database = await databaseWith((path) => new WorkIntelligenceStore(path).close());
    expect(database.identity.lineageId).not.toBeNull();

    const api = startApi({ database, port: 0 });
    apis.push(api);

    expect((await api.listening).databaseIdentity).toEqual(database.identity);
  });
});

describe("startApi when setting up the service throws", () => {
  it("closes the store, reports kind setup and leaves a handle that shuts down", async () => {
    vi.resetModules();
    vi.doMock("../../apps/server/src/backup-worker-client.js", () => ({
      BackupWorkerClient: class {
        constructor() {
          throw new Error("worker could not start at /synthetic/secret");
        }
      },
    }));
    const { startApi: isolatedStartApi } = await import("../../apps/server/src/start-api.js");
    const database = await databaseWith((path) => new WorkIntelligenceStore(path).close());

    const api = isolatedStartApi({ database, port: 0 });
    await expect(api.listening).rejects.toBeInstanceOf(
      (await import("../../apps/server/src/start-api.js")).StartApiError,
    );
    await expect(api.listening).rejects.toMatchObject({ kind: "setup" });
    await expect(api.shutdown()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("/synthetic/secret");
    // The store was closed: the file can be opened exclusively again.
    new WorkIntelligenceStore(database.path).close();
    vi.doUnmock("../../apps/server/src/backup-worker-client.js");
    vi.resetModules();
  });
});

describe("StartApiError", () => {
  it("carries its kind", () => {
    expect(new StartApiError("setup", "x").kind).toBe("setup");
  });
});

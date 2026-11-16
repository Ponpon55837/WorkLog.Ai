import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  DatabaseInitializationError,
  LATEST_SCHEMA_VERSION,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import {
  BarrierSandbox,
  freePort,
  inspectDatabase,
  StdioJsonRpcClient,
  type DatabaseSnapshot,
} from "../helpers/old-writer-barrier.js";

// DT-04 (desktop design R4 section 10.4): two real Node processes share one WAL database. Process A is an "old
// writer" that opened it at the current schema and idles; process B snapshots the file and then runs a synthetic
// "new version" migration (real DDL plus a schema_migrations row). Then A writes. Synthetic data only, temp
// directories only, random ports. Set OLD_WRITER_BARRIER_TABLE=1 to print the results table.
interface MigrationResult {
  type: string;
  ok: boolean;
  before: { pragmaSchemaVersion: number; highestMigration: number };
  after?: { pragmaSchemaVersion: number; highestMigration: number };
  error?: { name: string; message: string; sqliteCode?: number };
}

interface WriteResult {
  type: string;
  ok: boolean;
  outcome?: string;
  error?: { name: string; message: string; code?: string };
}

interface ResultRow {
  variant: string;
  schemaBefore: string;
  schemaAfter: string;
  response: string;
  rowsWrittenByRefusedWrite: number;
  integrity: string;
}

const MCP_ENTRY = "tests/helpers/old-writer-barrier-mcp-entry.ts";
const FUTURE_VERSION = LATEST_SCHEMA_VERSION + 1;
const RESTART_MESSAGE = "資料庫 schema 已更新，請重新啟動 Work Intelligence server。";
const sandboxes: BarrierSandbox[] = [];
const resultRows: ResultRow[] = [];

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    await sandbox.stopAll();
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (process.env.OLD_WRITER_BARRIER_TABLE) console.table(resultRows);
});

function createSandbox(): BarrierSandbox {
  const sandbox = new BarrierSandbox();
  sandboxes.push(sandbox);
  const store = new WorkIntelligenceStore(sandbox.databasePath);
  try {
    const project = store.addProject("Apiary", sandbox.projectRoot);
    store.updateProject(project.id, { status: "tracked" });
  } finally {
    store.close();
  }
  return sandbox;
}

/** Process B: snapshot, then migrate. Resolves with what B saw and did. */
async function migrateInAnotherProcess(
  sandbox: BarrierSandbox,
  options: { snapshot?: boolean; busyTimeoutMs?: number } = {},
): Promise<MigrationResult> {
  const migrator = sandbox.spawnWorker([
    "migrator",
    sandbox.databasePath,
    options.snapshot === false ? "" : sandbox.snapshotPath,
    String(FUTURE_VERSION),
    String(options.busyTimeoutMs ?? 5000),
  ]);
  const result = await migrator.waitFor<MigrationResult>("migration-result");
  await migrator.exited;
  return result;
}

function recordRow(variant: string, migration: MigrationResult, response: string, database: DatabaseSnapshot): void {
  resultRows.push({
    variant,
    schemaBefore: `pragma ${migration.before.pragmaSchemaVersion} / migration ${migration.before.highestMigration}`,
    schemaAfter: migration.after
      ? `pragma ${migration.after.pragmaSchemaVersion} / migration ${migration.after.highestMigration}`
      : "(migration did not apply)",
    response,
    rowsWrittenByRefusedWrite:
      database.sessionTitles.filter((title) => title.includes("refused")).length +
      database.projectNames.filter((name) => name.includes("Refused")).length,
    integrity: database.integrity,
  });
}

function mcpFinalizeCall(key: string) {
  return {
    name: "work_write_idempotent",
    arguments: {
      operation: "work_finalize_session",
      arguments: {
        projectRoot: "",
        idempotencyKey: key,
        title: `Barrier probe ${key}`,
        summary: "Synthetic write from a long-lived old MCP server.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      },
    },
  };
}

async function callMcpFinalize(
  client: StdioJsonRpcClient,
  projectRoot: string,
  key: string,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const call = mcpFinalizeCall(key);
  call.arguments.arguments.projectRoot = projectRoot;
  const answer = await client.request("tools/call", call);
  const result = answer.result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]?.text ?? "null") };
}

describe("old writer barrier (DT-04, design R4 section 10.4)", () => {
  it("1. long-lived MCP server over stdio refuses a write after another process migrated the database", async () => {
    const sandbox = createSandbox();
    const mcp = sandbox.spawnEntry(MCP_ENTRY);
    await mcp.waitForLine(/connected using/);
    const client = new StdioJsonRpcClient(mcp);
    await client.initialize();
    const baseline = await callMcpFinalize(client, sandbox.projectRoot, "baseline-ok");
    expect(baseline, JSON.stringify(baseline.payload)).toMatchObject({ isError: false });

    const migration = await migrateInAnotherProcess(sandbox);
    const refused = await callMcpFinalize(client, sandbox.projectRoot, "refused-after-migration");

    expect(migration).toMatchObject({ ok: true, after: { highestMigration: FUTURE_VERSION } });
    expect(migration.after?.pragmaSchemaVersion).toBeGreaterThan(migration.before.pragmaSchemaVersion);
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({ code: "MCP_RESTART_REQUIRED" });
    const database = inspectDatabase(sandbox.databasePath);
    expect(database.sessionTitles).toEqual(["Barrier probe baseline-ok"]);
    expect(database.integrity).toBe("ok");
    recordRow(
      "MCP stdio (real server, standalone wiring)",
      migration,
      `isError, code ${String(refused.payload.code)}`,
      database,
    );
  });

  it("2. long-lived HTTP API server answers 503 server_restart_required and writes nothing", async () => {
    const sandbox = createSandbox();
    const port = await freePort();
    const api = sandbox.spawnEntry("apps/server/src/index.ts", [], { WORK_INTELLIGENCE_PORT: String(port) });
    await api.waitForLine(/listening on/);
    const baseUrl = `http://127.0.0.1:${port}`;
    const post = (name: string) =>
      fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, rootPath: `${sandbox.root}/${name}` }),
      });
    expect((await post("Burrow")).status).toBe(201);

    const migration = await migrateInAnotherProcess(sandbox);
    const refused = await post("Refused");
    const body = await refused.json();
    const read = await fetch(`${baseUrl}/api/projects`);

    expect(refused.status).toBe(503);
    expect(body).toEqual({ error: RESTART_MESSAGE, code: "server_restart_required" });
    expect(read.status).toBe(200);
    const database = inspectDatabase(sandbox.databasePath);
    expect(database.projectNames).toEqual(["Apiary", "Burrow"]);
    expect(database.integrity).toBe("ok");
    recordRow(
      "HTTP API (apps/server/src/index.ts)",
      migration,
      `HTTP ${refused.status} ${JSON.stringify(body)}`,
      database,
    );
  });

  it("3a. long-lived store process (CLI-style writer or long task) is rejected at commit and keeps its snapshot readable", async () => {
    const sandbox = createSandbox();
    const writer = sandbox.spawnWorker(["store-writer", sandbox.databasePath, sandbox.projectRoot]);
    await writer.waitFor("ready");
    writer.send({ type: "write", key: "baseline-ok" });
    expect(await writer.waitFor<WriteResult>("write-result")).toMatchObject({ ok: true, outcome: "finalized" });

    const migration = await migrateInAnotherProcess(sandbox);
    writer.send({ type: "write", key: "refused-after-migration" });
    const refused = await writer.waitFor<WriteResult>("write-result");
    writer.send({ type: "close" });
    await writer.exited;

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({ name: "DatabaseSchemaChangedError", code: "DATABASE_SCHEMA_CHANGED" });
    const database = inspectDatabase(sandbox.databasePath);
    expect(database.sessionTitles).toEqual(["Barrier probe baseline-ok"]);
    expect(database.integrity).toBe("ok");
    recordRow(
      "Long-lived Store process (CLI / long task commit)",
      migration,
      `${refused.error?.name} code ${refused.error?.code}`,
      database,
    );

    // The pre-migration snapshot is a complete, readable copy of the old schema, and the app can open it.
    const snapshot = inspectDatabase(sandbox.snapshotPath);
    expect(snapshot).toMatchObject({ integrity: "ok", highestMigration: LATEST_SCHEMA_VERSION, hasFutureTable: false });
    expect(snapshot.sessionTitles).toEqual(["Barrier probe baseline-ok"]);
    const snapshotStore = new WorkIntelligenceStore(sandbox.snapshotPath);
    try {
      expect(snapshotStore.listProjects().map((project) => project.name)).toEqual(["Apiary"]);
    } finally {
      snapshotStore.close();
    }
  });

  it("3b. a long task already holding the write lock blocks the migration; its commit is legitimate and migrates after", async () => {
    const sandbox = createSandbox();
    const setup = new DatabaseSync(sandbox.databasePath);
    setup.exec("CREATE TABLE barrier_probe (id TEXT PRIMARY KEY)");
    setup.close();
    const holder = sandbox.spawnWorker(["lock-holder", sandbox.databasePath]);
    await holder.waitFor("lock-held");

    const blocked = await migrateInAnotherProcess(sandbox, { busyTimeoutMs: 0 });
    const snapshotWhileHeld = inspectDatabase(sandbox.snapshotPath);
    holder.send({ type: "commit" });
    await holder.waitFor("committed");
    const migration = await migrateInAnotherProcess(sandbox, { snapshot: false });

    expect(blocked.ok).toBe(false);
    expect(blocked.error?.sqliteCode).toBe(5);
    expect(blocked.after).toBeUndefined();
    expect(snapshotWhileHeld.integrity).toBe("ok");
    expect(migration).toMatchObject({ ok: true, after: { highestMigration: FUTURE_VERSION } });
    const probeRows = new DatabaseSync(sandbox.databasePath, { readOnly: true });
    try {
      expect(probeRows.prepare("SELECT id FROM barrier_probe").all()).toEqual([{ id: "held-by-long-task" }]);
    } finally {
      probeRows.close();
    }
    const database = inspectDatabase(sandbox.databasePath);
    expect(database).toMatchObject({ integrity: "ok", highestMigration: FUTURE_VERSION, hasFutureTable: true });
    recordRow(
      "Lock held by long task, migration attempted",
      blocked,
      `migration SQLITE_BUSY (${blocked.error?.sqliteCode}); task commit kept, 2nd migration ok`,
      database,
    );
  });

  it("4. an old process started after the migration refuses to open the database (CLI, MCP and Store)", async () => {
    const sandbox = createSandbox();
    const migration = await migrateInAnotherProcess(sandbox);

    let storeError: unknown;
    try {
      new WorkIntelligenceStore(sandbox.databasePath).close();
    } catch (error) {
      storeError = error;
    }
    const cli = sandbox.spawnEntry("apps/server/src/cli.ts", ["backup"]);
    const cliExit = await cli.exited;
    const mcp = sandbox.spawnEntry(MCP_ENTRY);
    await mcp.waitForLine(/DATABASE_SCHEMA_VERSION_TOO_NEW/);
    const client = new StdioJsonRpcClient(mcp);
    await client.initialize();
    const refused = await callMcpFinalize(client, sandbox.projectRoot, "refused-late-start");

    expect(storeError).toBeInstanceOf(DatabaseInitializationError);
    expect((storeError as DatabaseInitializationError).code).toBe("DATABASE_SCHEMA_VERSION_TOO_NEW");
    expect(cliExit).not.toBe(0);
    expect(cli.stderr()).toContain(String(FUTURE_VERSION));
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({ code: "DATABASE_SCHEMA_VERSION_TOO_NEW" });
    const database = inspectDatabase(sandbox.databasePath);
    expect(database.sessionTitles).toEqual([]);
    expect(database.integrity).toBe("ok");
    recordRow(
      "Old process started after migration (Store, CLI backup, MCP)",
      migration,
      `DATABASE_SCHEMA_VERSION_TOO_NEW; CLI exit ${cliExit}`,
      database,
    );
  });
});

import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// Child-process entry for tests/server/old-writer-barrier.test.ts. Every role talks to the test over the IPC channel
// with explicit messages, so the test never waits on a timer. Fictional data only.
type WorkerRole = "store-writer" | "lock-holder" | "migrator";
type WorkerMessage = { type: string; [key: string]: unknown };

interface DatabaseState {
  /** PRAGMA schema_version: moves on every DDL statement. */
  pragmaSchemaVersion: number;
  /** The highest row in schema_migrations: what the write gate compares. */
  highestMigration: number;
}

const FUTURE_MIGRATION_NAME = "synthetic_future_release";

function send(message: WorkerMessage): void {
  process.send?.(message);
}

function describeError(error: unknown): { name: string; message: string; code?: string; sqliteCode?: number } {
  const value = error as { name?: string; message?: string; code?: string; errcode?: number };
  return {
    name: value.name ?? "Error",
    message: value.message ?? String(error),
    ...(value.code ? { code: value.code } : {}),
    ...(typeof value.errcode === "number" ? { sqliteCode: value.errcode } : {}),
  };
}

function nextCommand(): Promise<WorkerMessage> {
  return new Promise((resolve) => process.once("message", (message) => resolve(message as WorkerMessage)));
}

function readState(db: DatabaseSync): DatabaseState {
  const pragma = db.prepare("PRAGMA schema_version").get() as { schema_version: number };
  const highest = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  return { pragmaSchemaVersion: pragma.schema_version, highestMigration: highest.version };
}

/** An old release's long-lived process: opens the store at its own schema, idles, and writes only when told to. */
async function runStoreWriter(databasePath: string, projectRoot: string): Promise<void> {
  const store = new WorkIntelligenceStore(databasePath);
  send({ type: "ready" });
  for (;;) {
    const command = await nextCommand();
    if (command.type === "close") {
      store.close();
      send({ type: "closed" });
      return;
    }
    const idempotencyKey = String(command.key);
    try {
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey,
        title: `Barrier probe ${idempotencyKey}`,
        summary: "Synthetic write from a long-lived old process.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      });
      send({ type: "write-result", key: idempotencyKey, ok: true, outcome: result.outcome });
    } catch (error) {
      send({ type: "write-result", key: idempotencyKey, ok: false, error: describeError(error) });
    }
  }
}

/** A long task that already holds the write lock (raw connection: it stands for an uncommitted transaction). */
async function runLockHolder(databasePath: string): Promise<void> {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO barrier_probe (id) VALUES (?)").run("held-by-long-task");
  send({ type: "lock-held" });
  await nextCommand();
  db.exec("COMMIT");
  db.close();
  send({ type: "committed" });
}

/** The "new version": snapshot first (VACUUM INTO), then a real DDL change plus a schema_migrations row. */
function runMigrator(databasePath: string, snapshotPath: string, nextVersion: number, busyTimeoutMs: number): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    const before = readState(db);
    if (snapshotPath) db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ALTER TABLE projects ADD COLUMN synthetic_future_flag INTEGER NOT NULL DEFAULT 0");
      db.exec("CREATE TABLE synthetic_future_feature (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        nextVersion,
        FUTURE_MIGRATION_NAME,
        "2030-01-01T00:00:00.000Z",
      );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      send({ type: "migration-result", ok: false, before, error: describeError(error) });
      return;
    }
    send({ type: "migration-result", ok: true, before, after: readState(db), snapshotPath });
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [role, ...args] = process.argv.slice(2) as [WorkerRole, ...string[]];
  if (role === "store-writer") await runStoreWriter(args[0] ?? "", args[1] ?? "");
  else if (role === "lock-holder") await runLockHolder(args[0] ?? "");
  else if (role === "migrator") runMigrator(args[0] ?? "", args[1] ?? "", Number(args[2]), Number(args[3] ?? 5000));
  else throw new Error(`Unknown worker role: ${String(role)}`);
}

await main();
// Closing the channel flushes the last message and lets the process end on its own.
process.disconnect();

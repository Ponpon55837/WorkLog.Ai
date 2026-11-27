import { DatabaseSync } from "node:sqlite";
import {
  initializeWorkIntelligenceDatabase,
  restoreDatabase,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION, schemaMigrationSql } from "../../packages/storage/src/schema-migrations.js";

const MAX_HOLD_MS = 120_000;

type Hold = (inTransaction: boolean) => never;

const [role, databasePath, backupDirectory, restoreSource] = process.argv.slice(2) as [
  string,
  string,
  string,
  string | undefined,
];

function finish(): void {
  process.send?.({ type: "done" }, () => process.exit(0));
}

const hold: Hold = (inTransaction) => {
  process.send?.({ type: "mid", inTransaction });
  const started = Date.now();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  // A test that dies without killing its worker must not leave it behind.
  while (Date.now() - started < MAX_HOLD_MS) Atomics.wait(cell, 0, 0, 1000);
  process.exit(3);
};

function wrapped(db: DatabaseSync, point: "migration" | "backup"): DatabaseSync {
  const migrationSql = schemaMigrationSql(LATEST_SCHEMA_VERSION);
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "exec" && point === "migration") {
        return (sql: string) => {
          const result = target.exec(sql);
          if (sql === migrationSql && target.isTransaction) hold(true);
          return result;
        };
      }
      if (property === "prepare" && point === "backup") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("VACUUM INTO")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const member = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              if (statementProperty !== "run")
                return typeof member === "function" ? member.bind(statementTarget) : member;
              return (...parameters: never[]) => {
                const result = statementTarget.run(...parameters);
                hold(target.isTransaction);
                return result;
              };
            },
          });
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

if (role === "open-store") {
  process.send?.({ type: "ready" });
  process.once("message", () => {
    const store = new WorkIntelligenceStore(databasePath, { backup: { directory: backupDirectory } });
    store.close();
    finish();
  });
} else if (role === "hold-migration" || role === "hold-backup") {
  const db = new DatabaseSync(databasePath);
  initializeWorkIntelligenceDatabase(wrapped(db, role === "hold-migration" ? "migration" : "backup"), databasePath, {
    directory: backupDirectory,
  });
  db.close();
  finish();
} else if (role === "hold-restore" && restoreSource) {
  restoreDatabase({
    source: restoreSource,
    databasePath,
    backupDirectory,
    initializeStaging: (staging) => {
      initializeWorkIntelligenceDatabase(staging, ":memory:");
      hold(false);
    },
  });
  finish();
} else {
  throw new Error(`Unknown worker role: ${String(role)}`);
}

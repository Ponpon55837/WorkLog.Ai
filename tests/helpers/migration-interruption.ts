import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { undoMigrationsAfter } from "./schema-migration-fixture.js";

export type HoldPoint = "migration" | "backup" | "restore";

export const DEFAULT_OLD_SCHEMA_VERSION = LATEST_SCHEMA_VERSION - 1;

export function createOldSchemaDatabase(
  databasePath: string,
  projectRoot: string,
  schemaVersion = DEFAULT_OLD_SCHEMA_VERSION,
): void {
  mkdirSync(projectRoot, { recursive: true });
  const store = new WorkIntelligenceStore(databasePath, { backup: { directory: `${databasePath}.seed-backups` } });
  try {
    const project = store.addProject("Orchard", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    for (const index of [0, 1, 2]) {
      store.finalizeSession({
        projectRoot,
        idempotencyKey: `interruption-seed-${index}`,
        title: `Prune the pear tree ${index}`,
        summary: `Pruned branch ${index} before the frost.`,
        workSummary: {
          outcomes: [`Branch ${index} pruned.`],
          scope: ["src/pear.ts"],
          decisions: [],
          verification: ["pnpm test passed."],
          nextSteps: [],
        },
        changedFiles: ["src/pear.ts"],
        verification: { status: "passed" },
      });
    }
  } finally {
    store.close();
  }
  const db = new DatabaseSync(databasePath);
  try {
    undoMigrationsAfter(db, schemaVersion);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export function copyDatabaseFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

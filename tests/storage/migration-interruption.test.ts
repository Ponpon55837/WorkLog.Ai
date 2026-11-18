import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listDatabaseBackups, restoreDatabase } from "../../packages/storage/src/backup.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { fingerprintDatabase, type FingerprintOptions } from "../helpers/database-fingerprint.js";
import { BarrierSandbox, inspectDatabase, type Waiter } from "../helpers/old-writer-barrier.js";
import {
  copyDatabaseFile,
  createOldSchemaDatabase,
  DEFAULT_OLD_SCHEMA_VERSION,
} from "../helpers/migration-interruption.js";

// Real child processes are killed with SIGKILL (TerminateProcess on Windows) at known points of the pre-migration
// backup, the migration transaction and a restore, and at random moments of the unmodified production path. Every case
// ends with the same checks: the database is whole, no half-written backup is published, and the next open finishes
// the upgrade with the content an uninterrupted upgrade gives. Fictional data only. The seed reproduces the delays and
// plan shapes, not the exact wall-clock moments at which a kill lands.
const WORKER = join(import.meta.dirname, "../helpers/migration-interruption-worker.ts");
const OLD_VERSION = DEFAULT_OLD_SCHEMA_VERSION;
/** The one value an upgrade writes with the wall clock; everything else is content a second upgrade reproduces. */
const UPGRADE_COMPARISON: FingerprintOptions = { excludeTables: ["schema_migrations"] };
/**
 * Columns a restore legitimately replaces: it assigns a fresh database id and sets both revision counters above the
 * larger of the replaced and the restored value, so an observer's `changed` event fires.
 */
const RESTORE_COMPARISON: FingerprintOptions = {
  excludeTables: ["schema_migrations"],
  ignoreColumns: { change_revisions: ["database_id", "data_revision", "audit_revision"] },
};
const KILL_ITERATIONS = parseKillIterations(process.env.WI_MIGRATION_KILL_ITERATIONS);
const KILL_BATCH_SIZE = 5;
const KILL_SEED = Number(process.env.WI_MIGRATION_KILL_SEED ?? Math.floor(Math.random() * 2 ** 31));
const KILL_TOTAL_BUDGET_MS = 60_000;
/** Per batch: spawning five workers, a calibration run and five kill/reopen cycles; the shared budget above still bounds the series. */
const KILL_BATCH_TIMEOUT_MS = 90_000;
const SOURCE_DATABASE = process.env.WI_MIGRATION_SOURCE_DB;

let sandbox: BarrierSandbox;
let sourcePath: string;
let counter = 0;
/** Shared by the random-kill batches so the whole series stays inside its budget; started once a batch's workers are ready. */
let killSeriesStartedAt: number | undefined;

function parseKillIterations(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`WI_MIGRATION_KILL_ITERATIONS must be a positive integer (got "${raw}").`);
  }
  return value;
}

/** A small deterministic generator, so a failing run can be repeated from its printed seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function place(name: string): { databasePath: string; backupDirectory: string } {
  counter += 1;
  const directory = join(sandbox.root, `${name}-${counter}`);
  mkdirSync(directory, { recursive: true });
  return { databasePath: join(directory, "work-intelligence.sqlite"), backupDirectory: join(directory, "backups") };
}

function copyOfSource(name: string): { databasePath: string; backupDirectory: string } {
  const location = place(name);
  copyDatabaseFile(sourcePath, location.databasePath);
  return location;
}

function openAndClose(location: { databasePath: string; backupDirectory: string }): void {
  const store = new WorkIntelligenceStore(location.databasePath, { backup: { directory: location.backupDirectory } });
  store.close();
}

function worker(role: string, location: { databasePath: string; backupDirectory: string }, extra?: string): Waiter {
  return sandbox.spawnIpc(WORKER, [role, location.databasePath, location.backupDirectory, ...(extra ? [extra] : [])]);
}

async function killWhenHeld(role: string, location: { databasePath: string; backupDirectory: string }, extra?: string) {
  const child = worker(role, location, extra);
  const mid = await child.waitFor<{ type: "mid"; inTransaction: boolean }>("mid");
  child.child.kill("SIGKILL");
  await child.exited;
  return { mid, pid: child.child.pid };
}

function stagingEntries(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith(".wi-")) : [];
}

function publishedBackups(location: { databasePath: string; backupDirectory: string }) {
  return listDatabaseBackups(location.databasePath, location.backupDirectory);
}

function quickCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
  } finally {
    db.close();
  }
}

/** One upgrade without interruption, made in this process: what every interrupted upgrade must end up equal to. */
function uninterruptedUpgrade(): ReturnType<typeof fingerprintDatabase> {
  const location = copyOfSource("reference");
  openAndClose(location);
  return fingerprintDatabase(location.databasePath, UPGRADE_COMPARISON);
}

beforeAll(() => {
  sandbox = new BarrierSandbox();
  if (SOURCE_DATABASE) {
    sourcePath = SOURCE_DATABASE;
  } else {
    sourcePath = join(sandbox.root, "source", "work-intelligence.sqlite");
    createOldSchemaDatabase(sourcePath, join(sandbox.root, "source", "orchard"));
  }
});

afterEach(async () => {
  await sandbox.stopAll();
});

afterAll(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("an upgrade killed at a known point", () => {
  it("killed inside the migration transaction: old schema intact, one valid backup, next open finishes", async () => {
    const reference = uninterruptedUpgrade();
    const sourceContent = fingerprintDatabase(sourcePath);
    const location = copyOfSource("mid-migration");

    const { mid } = await killWhenHeld("hold-migration", location);

    expect(mid.inTransaction).toBe(true);
    const after = inspectDatabase(location.databasePath);
    expect(after.integrity).toBe("ok");
    expect(after.highestMigration).toBe(OLD_VERSION);
    expect(fingerprintDatabase(location.databasePath)).toEqual(sourceContent);
    const backups = publishedBackups(location);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ kind: "migration" });
    const backupPath = join(location.backupDirectory, backups[0]!.fileName);
    expect(quickCheck(backupPath)).toBe("ok");
    expect(fingerprintDatabase(backupPath)).toEqual(sourceContent);
    expect(stagingEntries(location.backupDirectory)).toEqual([]);

    openAndClose(location);

    expect(inspectDatabase(location.databasePath)).toMatchObject({
      integrity: "ok",
      highestMigration: LATEST_SCHEMA_VERSION,
    });
    expect(fingerprintDatabase(location.databasePath, UPGRADE_COMPARISON)).toEqual(reference);
  });

  it("killed while the pre-migration backup is being written: nothing published, then it is cleaned up and redone", async () => {
    const reference = uninterruptedUpgrade();
    const sourceContent = fingerprintDatabase(sourcePath);
    const location = copyOfSource("mid-backup");

    const { pid } = await killWhenHeld("hold-backup", location);

    expect(publishedBackups(location)).toEqual([]);
    expect(readdirSync(location.backupDirectory).filter((name) => name.endsWith(".sqlite"))).toEqual([]);
    const leftovers = stagingEntries(location.backupDirectory);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(new RegExp(`^\\.wi-${pid}-[0-9a-f-]{36}\\.tmp$`));
    expect(inspectDatabase(location.databasePath)).toMatchObject({ integrity: "ok", highestMigration: OLD_VERSION });
    expect(fingerprintDatabase(location.databasePath)).toEqual(sourceContent);

    openAndClose(location);

    expect(stagingEntries(location.backupDirectory)).toEqual([]);
    const backups = publishedBackups(location);
    expect(backups).toHaveLength(1);
    expect(fingerprintDatabase(join(location.backupDirectory, backups[0]!.fileName))).toEqual(sourceContent);
    expect(inspectDatabase(location.databasePath)).toMatchObject({
      integrity: "ok",
      highestMigration: LATEST_SCHEMA_VERSION,
    });
    expect(fingerprintDatabase(location.databasePath, UPGRADE_COMPARISON)).toEqual(reference);
  });
});

describe.each(Array.from({ length: Math.ceil(KILL_ITERATIONS / KILL_BATCH_SIZE) }, (_unused, batch) => batch))(
  "an upgrade killed at a random moment, batch %i",
  (batch) => {
    it(
      `leaves the database whole and finishes on the next open (seed ${KILL_SEED})`,
      async () => {
        const killLog: string[] = [];
        const reference = uninterruptedUpgrade();
        const sourceContent = fingerprintDatabase(sourcePath);
        const first = batch * KILL_BATCH_SIZE;
        const count = Math.min(KILL_BATCH_SIZE, KILL_ITERATIONS - first);
        // All workers of the batch are started together; each waits at `ready` with its imports loaded.
        const runs = Array.from({ length: count }, (_unused, index) => {
          const location = copyOfSource(`kill-${first + index}`);
          return { iteration: first + index, location, child: worker("open-store", location) };
        });
        await Promise.all(runs.map((run) => run.child.waitFor("ready")));
        killSeriesStartedAt ??= Date.now();
        // The span of an uninterrupted open, measured once here, bounds the random delays.
        const calibration = copyOfSource("calibration");
        const timer = worker("open-store", calibration);
        await timer.waitFor("ready");
        const measuredFrom = performance.now();
        timer.send({ type: "go" });
        await timer.waitFor("done");
        const window = Math.max(25, (performance.now() - measuredFrom) * 1.5);

        for (const run of runs) {
          const elapsed = Date.now() - killSeriesStartedAt;
          if (elapsed > KILL_TOTAL_BUDGET_MS) {
            throw new Error(
              `Random kill series exceeded ${KILL_TOTAL_BUDGET_MS} ms at iteration ${run.iteration} (seed ${KILL_SEED}).\n${killLog.join("\n")}`,
            );
          }
          const delay = seededRandom(KILL_SEED + run.iteration)() * window;
          run.child.send({ type: "go" });
          await new Promise((resolve) => setTimeout(resolve, delay));
          run.child.child.kill("SIGKILL");
          await run.child.exited;

          const state = inspectDatabase(run.location.databasePath);
          const outcome = state.highestMigration === LATEST_SCHEMA_VERSION ? "new" : "old";
          killLog.push(`#${run.iteration} delay=${delay.toFixed(1)}ms -> ${outcome}`);
          const context = `seed ${KILL_SEED}, iteration ${run.iteration}, delay ${delay.toFixed(1)} ms\n${killLog.join("\n")}`;
          expect(state.integrity, context).toBe("ok");
          expect([OLD_VERSION, LATEST_SCHEMA_VERSION], context).toContain(state.highestMigration);
          if (outcome === "old") {
            expect(fingerprintDatabase(run.location.databasePath), context).toEqual(sourceContent);
          } else {
            expect(fingerprintDatabase(run.location.databasePath, UPGRADE_COMPARISON), context).toEqual(reference);
          }
          // Any backup that was published is whole and holds the pre-upgrade content.
          for (const backup of publishedBackups(run.location)) {
            const backupPath = join(run.location.backupDirectory, backup.fileName);
            expect(quickCheck(backupPath), context).toBe("ok");
            expect(fingerprintDatabase(backupPath), context).toEqual(sourceContent);
          }

          openAndClose(run.location);

          expect(inspectDatabase(run.location.databasePath), context).toMatchObject({
            integrity: "ok",
            highestMigration: LATEST_SCHEMA_VERSION,
          });
          expect(fingerprintDatabase(run.location.databasePath, UPGRADE_COMPARISON), context).toEqual(reference);
        }
        console.info(
          `migration kill series seed ${KILL_SEED}, batch ${batch}, window ${window.toFixed(1)} ms\n${killLog.join("\n")}`,
        );
      },
      KILL_BATCH_TIMEOUT_MS,
    );
  },
);

describe("restoring the pre-migration backup after an upgrade", () => {
  /** Upgrades a copy of the source, writes rows after the upgrade, and returns the pre-migration backup. */
  function upgradedWithLaterRows() {
    const location = copyOfSource("restore");
    const store = new WorkIntelligenceStore(location.databasePath, { backup: { directory: location.backupDirectory } });
    try {
      store.addProject("Late Orchard", join(sandbox.root, "late-orchard"));
    } finally {
      store.close();
    }
    const backup = publishedBackups(location).find((entry) => entry.kind === "migration");
    if (!backup) throw new Error("The upgrade wrote no pre-migration backup.");
    return { ...location, backupPath: join(location.backupDirectory, backup.fileName) };
  }

  it("writes a safety snapshot first and returns to the upgraded content without the later rows", () => {
    const reference = (() => {
      const location = copyOfSource("restore-reference");
      openAndClose(location);
      return fingerprintDatabase(location.databasePath, RESTORE_COMPARISON);
    })();
    const location = upgradedWithLaterRows();
    const beforeRestore = fingerprintDatabase(location.databasePath);

    const result = restoreDatabase({
      source: location.backupPath,
      databasePath: location.databasePath,
      backupDirectory: location.backupDirectory,
      initializeStaging: (database) => initializeWorkIntelligenceDatabase(database, ":memory:"),
    });

    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.safetyBackup).toBeDefined();
    const safetyPath = join(location.backupDirectory, result.safetyBackup!);
    expect(quickCheck(safetyPath)).toBe("ok");
    expect(fingerprintDatabase(safetyPath)).toEqual(beforeRestore);
    expect(inspectDatabase(location.databasePath)).toMatchObject({
      integrity: "ok",
      highestMigration: LATEST_SCHEMA_VERSION,
    });
    expect(inspectDatabase(location.databasePath).projectNames).not.toContain("Late Orchard");
    expect(fingerprintDatabase(location.databasePath, RESTORE_COMPARISON)).toEqual(reference);
    expect(existsSync(`${location.databasePath}.restoring`)).toBe(false);
  });

  it("killed before it replaces the database: the live database is unchanged and the next restore cleans the staging copy", async () => {
    const location = upgradedWithLaterRows();
    const live = fingerprintDatabase(location.databasePath);

    const { mid } = await killWhenHeld("hold-restore", location, location.backupPath);

    expect(mid.inTransaction).toBe(false);
    expect(existsSync(`${location.databasePath}.restoring`)).toBe(true);
    expect(fingerprintDatabase(location.databasePath)).toEqual(live);
    expect(inspectDatabase(location.databasePath)).toMatchObject({
      integrity: "ok",
      highestMigration: LATEST_SCHEMA_VERSION,
    });
    // The safety snapshot of the live database was written before the staging copy was started.
    const safety = publishedBackups(location).filter((entry) => entry.kind === "manual");
    expect(safety).toHaveLength(1);
    expect(fingerprintDatabase(join(location.backupDirectory, safety[0]!.fileName))).toEqual(live);
    // A normal open works and ignores the staging file.
    openAndClose(location);
    expect(fingerprintDatabase(location.databasePath)).toEqual(live);

    const result = restoreDatabase({
      source: location.backupPath,
      databasePath: location.databasePath,
      backupDirectory: location.backupDirectory,
      initializeStaging: (database) => initializeWorkIntelligenceDatabase(database, ":memory:"),
    });

    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    for (const suffix of ["", "-wal", "-shm"])
      expect(existsSync(`${location.databasePath}.restoring${suffix}`)).toBe(false);
    expect(inspectDatabase(location.databasePath).projectNames).not.toContain("Late Orchard");
  });
});

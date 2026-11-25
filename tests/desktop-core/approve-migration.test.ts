// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageRisk } from "../../packages/desktop-core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";

// Only `app` and `dialog` of Electron are read by the main modules, and neither runs here.
vi.mock("electron", () => ({ app: {}, dialog: { showMessageBox: vi.fn() } }));

const { createApproveMigration } = await import("../../apps/desktop/src/main/approve-migration.js");

/**
 * 「先備份再更新資料庫」 in main, on the committed schema-34 upgrade sample while the App is at a newer schema: one press runs a
 * fresh read-only preview, starts with the update allowed and identity pinned, and the start updates the copy and writes
 * the pre-migration backup, named after the first pending migration. A storage that refuses an update is refused before any preview or start. The backend child
 * is stood in for by the real store (the same migration and backup the child runs). Synthetic fixture only.
 */

const FIXTURE_SCHEMA_VERSION = 34;
const FIXTURE = resolve(import.meta.dirname, `../fixtures/upgrade/schema-${FIXTURE_SCHEMA_VERSION}.sqlite`);
const IDENTITY = { realPath: "/synthetic/identity.sqlite", fileId: null, lineageId: null };
const temporary: string[] = [];

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
  } finally {
    db.close();
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "wi-approve-migration-"));
  temporary.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  copyFileSync(FIXTURE, databasePath);
  return { databasePath, backups: join(root, "backups") };
}

function backupFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.includes("pre-migration-"));
  } catch {
    return [];
  }
}

function harness(options: { risk?: StorageRisk; known?: boolean; operation?: boolean } = {}) {
  const box = sandbox();
  const events: string[] = [];
  const starts: Array<{ kind: string; override: unknown }> = [];
  const risk = { risk: options.risk ?? "none" };
  const approve = createApproveMigration({
    state: { databasePath: () => box.databasePath, locale: "en" } as never,
    supervisor: {
      running: undefined,
      // The child's read-only preflight: the version on disk against the version this App ships.
      preview: async (path: string) => {
        events.push("preview");
        const version = schemaVersion(path);
        return {
          outcome: "checked",
          preflight: {
            type: "preflight-result",
            status: "ok",
            identity: IDENTITY,
            schemaVersion: version,
            compatibility: version < LATEST_SCHEMA_VERSION ? "older-needs-migration" : "current",
          },
          willMigrate: version < LATEST_SCHEMA_VERSION,
        };
      },
      queryActivity: async () => ({ status: "ok", busy: [], pendingImport: false }),
    } as never,
    storage: {
      last: () => (options.known === false ? undefined : risk),
      classify: async () => {
        events.push("classify");
        return risk;
      },
    } as never,
    backend: {
      recovery: { cancel: () => events.push("cancel-retry") },
      presenter: () => ({ present: (code: string) => events.push(`present:${code}`) }),
      // What the backend child does with the request: refuse an unapproved update, else back up and migrate.
      start: async (kind: string, override: { databasePath: string; allowSchemaMigration: boolean }) => {
        starts.push({ kind, override });
        if (schemaVersion(override.databasePath) < LATEST_SCHEMA_VERSION && !override.allowSchemaMigration) {
          return { ok: false, code: "SCHEMA_MIGRATION_BLOCKED" };
        }
        new WorkIntelligenceStore(override.databasePath, { backup: { directory: box.backups } }).close();
        return { ok: true };
      },
    } as never,
    success: { opens: () => 0, finish: (outcome: { ok: boolean }) => events.push(`finish:${outcome.ok}`) } as never,
    info: { snapshot: async () => ({ marker: "snapshot" }) } as never,
    operationRunning: () => options.operation === true,
    busyReason: () => ({ source: "unknown" }),
    log: () => undefined,
  });
  return { box, events, starts, approve };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe(`one press updates a schema-${FIXTURE_SCHEMA_VERSION} database to the App's schema`, () => {
  it("previews, starts with the update allowed and the identity pinned, and leaves a pre-migration backup", async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(FIXTURE_SCHEMA_VERSION);
    const { box, events, starts, approve } = harness();
    expect(schemaVersion(box.databasePath)).toBe(FIXTURE_SCHEMA_VERSION);

    const result = await approve();

    expect(result).toEqual({ ok: true, state: { marker: "snapshot" } });
    expect(starts).toEqual([
      {
        kind: "change-db",
        override: { databasePath: box.databasePath, expectedIdentity: IDENTITY, allowSchemaMigration: true },
      },
    ]);
    expect(events).toEqual(["preview", "cancel-retry", "finish:true"]);
    expect(schemaVersion(box.databasePath)).toBe(LATEST_SCHEMA_VERSION);
    expect(backupFiles(box.backups)).toHaveLength(1);
    expect(backupFiles(box.backups)[0]).toContain(`pre-migration-v${FIXTURE_SCHEMA_VERSION + 1}-`);
  });

  it("classifies the storage first when the start-up verdict is not known yet", async () => {
    const { events, approve } = harness({ known: false });
    expect((await approve()).ok).toBe(true);
    expect(events.slice(0, 2)).toEqual(["classify", "preview"]);
  });

  it("starts without the update flag when the preview finds nothing to update", async () => {
    const { box, starts, approve } = harness();
    new WorkIntelligenceStore(box.databasePath).close();
    expect((await approve()).ok).toBe(true);
    expect(starts[0]?.override).toMatchObject({ allowSchemaMigration: false });
  });

  it("unknown storage does not block the update", async () => {
    const { box, approve } = harness({ risk: "unknown" });
    expect((await approve()).ok).toBe(true);
    expect(schemaVersion(box.databasePath)).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe("what refuses the update", () => {
  it.each(["cloud-sync", "removable", "hard-link", "network"] as const)(
    "%s storage: refused before any preview or start, pointing at the copy to a local folder",
    async (risk) => {
      const { box, events, starts, approve } = harness({ risk });
      const result = await approve();
      expect(result).toMatchObject({ ok: false, reason: "invalid" });
      expect((result as { message?: string }).message).toContain("copies it to a local folder");
      expect(events).not.toContain("preview");
      expect(starts).toEqual([]);
      expect(schemaVersion(box.databasePath)).toBe(FIXTURE_SCHEMA_VERSION);
      expect(backupFiles(box.backups)).toEqual([]);
    },
  );

  it("waits while another operation holds the App: nothing is started and no retry is cancelled", async () => {
    const { box, starts, events, approve } = harness({ operation: true });
    expect(await approve()).toMatchObject({ ok: false, reason: "busy" });
    expect(starts).toEqual([]);
    expect(events).not.toContain("cancel-retry");
    expect(schemaVersion(box.databasePath)).toBe(FIXTURE_SCHEMA_VERSION);
  });
});

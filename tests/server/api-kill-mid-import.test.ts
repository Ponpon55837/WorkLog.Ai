import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDatabaseBusyError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { transferRoot } from "../../apps/server/src/transfer-workspace.js";
import { BarrierSandbox, freePort, REPOSITORY_ROOT, type Waiter } from "../helpers/old-writer-barrier.js";
import { writeImportRequest, writeSyntheticProjectExport } from "../helpers/synthetic-project-export.js";

// Fictional data only. The API process (a real desktop child, the way the App runs it) is killed while its background
// child writes a large import. The background child does not see the parent go until its one import transaction has
// ended, so the import lands whole (or, had it failed, not at all): never in part. The upload directory the dead API
// could not remove is left for the start-up sweep, which removes it once it is older than an hour.

const ENTRY = "tests/helpers/desktop-child-entry.ts";
const RUN_ID = "synthetic-run-id-0123456789abcdef-killapi";
// The export holds the 2,000 generated Sessions and the one template Session they are made from.
const IMPORTED_SESSIONS = 2_001;
const HOUR_MS = 60 * 60 * 1000;
const sandboxes: BarrierSandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.stopAll()));
});

function counts(databasePath: string): { sessions: number; projects: number; integrity: unknown } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: string) =>
      Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    return {
      sessions: count("sessions"),
      projects: count("projects"),
      integrity: database.prepare("PRAGMA integrity_check").get(),
    };
  } finally {
    database.close();
  }
}

/** True while another connection holds the database's write lock; never waits for it and never keeps it. */
function writeLockHeld(probe: DatabaseSync): boolean {
  try {
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
    return false;
  } catch (error) {
    if (isDatabaseBusyError(error)) return true;
    throw error;
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startApi(sandbox: BarrierSandbox): Promise<{ child: Waiter; port: number }> {
  const child = sandbox.spawnIpc(join(REPOSITORY_ROOT, ENTRY));
  await child.waitFor("hello");
  child.send({ type: "preflight", path: sandbox.databasePath });
  const verified = await child.waitFor<{ type: string; identity?: unknown }>("preflight-result");
  const port = await freePort();
  child.send({
    type: "start",
    runId: RUN_ID,
    port,
    database: { path: sandbox.databasePath, identity: verified.identity },
  });
  await child.waitFor("ready");
  return { child, port };
}

function transferDirectories(root: string): string[] {
  return existsSync(root) ? readdirSync(root).filter((name) => /^(import|export)-/.test(name)) : [];
}

describe("the API process killed in the middle of an import", () => {
  it("leaves the whole import or none of it, and the next start removes the upload it left behind", async () => {
    const sandbox = new BarrierSandbox();
    sandboxes.push(sandbox);
    const store = new WorkIntelligenceStore(sandbox.databasePath);
    const projectRoot = join(sandbox.root, "destination");
    mkdirSync(projectRoot);
    const project = store.addProject("Kill test destination", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    store.finalizeSession({
      projectRoot,
      idempotencyKey: "kill-api-session",
      title: "Synthetic destination Session",
      summary: "Already in the database before the import.",
      completedAt: "2026-04-01T00:00:00.000Z",
    });
    store.close();
    const bundleFile = join(sandbox.root, "export.json");
    writeSyntheticProjectExport(bundleFile, IMPORTED_SESSIONS - 1);
    const requestFile = join(sandbox.root, "request.json");
    writeImportRequest(bundleFile, requestFile);
    const before = counts(sandbox.databasePath);
    expect(before).toMatchObject({ sessions: 1, projects: 1 });

    const { child, port } = await startApi(sandbox);
    const probe = new DatabaseSync(sandbox.databasePath);
    probe.exec("PRAGMA busy_timeout = 0");
    try {
      let settled = false;
      const request = fetch(`http://127.0.0.1:${port}/api/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: readFileSync(requestFile),
      }).then(
        (response) => {
          settled = true;
          return response.status;
        },
        () => {
          settled = true;
          return "connection lost";
        },
      );
      await until(() => {
        if (settled) throw new Error("The import finished before its write lock was seen.");
        return writeLockHeld(probe);
      }, "the import to take the write lock");

      // SIGKILL cannot be handled; on Windows Node ends the process whatever the signal.
      child.child.kill("SIGKILL");
      await child.exited;
      expect(await request).toBe("connection lost");

      // The background child ends its transaction, then sees its parent gone and exits; the lock is released.
      await until(() => !writeLockHeld(probe), "the orphaned import to release the write lock");
    } finally {
      probe.close();
    }

    const after = counts(sandbox.databasePath);
    expect(after.integrity).toEqual({ integrity_check: "ok" });
    const whole = { sessions: before.sessions + IMPORTED_SESSIONS, projects: before.projects + 1 };
    const none = { sessions: before.sessions, projects: before.projects };
    expect([whole, none]).toContainEqual({ sessions: after.sessions, projects: after.projects });

    // The dead API could not remove its upload. A start more than an hour later (the directories are backdated)
    // removes it, and the API serves again.
    const root = transferRoot(sandbox.databasePath);
    const left = transferDirectories(root);
    expect(left).toHaveLength(1);
    const old = new Date(Date.now() - 2 * HOUR_MS);
    for (const name of left) utimesSync(join(root, name), old, old);
    const next = await startApi(sandbox);
    expect(transferDirectories(root)).toEqual([]);
    const health = await fetch(`http://127.0.0.1:${next.port}/api/health`);
    expect(health.status).toBe(200);
    expect(counts(sandbox.databasePath)).toEqual(after);
  }, 120_000);
});

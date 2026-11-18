// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StorageRisk } from "../../packages/desktop-core/src/index.js";
// The main-process module reads the built package, so the journal comes from the same build (one class, one type).
import {
  COPY_PATH_DETAIL,
  InMemoryOperationJournalStore,
  OperationJournal,
  type OperationRecord,
} from "../../packages/desktop-core/dist/index.js";

// Only `app` and `dialog` of Electron are read by these modules, and neither runs here.
vi.mock("electron", () => ({ app: {}, dialog: { showMessageBox: vi.fn() } }));

const { createCopyRunner, createLocalCopy, uniqueCopyTarget } =
  await import("../../apps/desktop/src/main/local-copy.js");

/**
 * 「複製到本機磁碟並改用」 in main: the unused-name rule, the target folder's own storage check, when a pending
 * automatic retry is cancelled, and what a failed switch records and shows. Synthetic paths and ids only.
 */

const IDENTITY = { realPath: "/synthetic/local/copy.sqlite", fileId: { device: "1", inode: "2" }, lineageId: "l" };

describe("the name of the copy", () => {
  it("is the first name nothing uses, counting the database and its WAL and shared-memory files", () => {
    // The names are joined with the platform's separator, as the App joins them.
    const folder = join("/synthetic", "data");
    const name = (file: string) => join(folder, file);
    const taken = new Set<string>();
    expect(uniqueCopyTarget(folder, (path) => taken.has(path))).toBe(name("work-intelligence-local.sqlite"));
    taken.add(name("work-intelligence-local.sqlite"));
    expect(uniqueCopyTarget(folder, (path) => taken.has(path))).toBe(name("work-intelligence-local-2.sqlite"));
    taken.add(name("work-intelligence-local-2.sqlite-wal"));
    taken.add(name("work-intelligence-local-3.sqlite-shm"));
    expect(uniqueCopyTarget(folder, (path) => taken.has(path))).toBe(name("work-intelligence-local-4.sqlite"));
  });
});

function runnerHarness(options: { targetRisk?: StorageRisk; classifierThrows?: boolean } = {}) {
  const events: string[] = [];
  const classified: string[] = [];
  const copyRequests: Array<[string, string]> = [];
  const openRecords: OperationRecord[] = [];
  const journal = new OperationJournal(new InMemoryOperationJournalStore());
  const runner = createCopyRunner({
    journal,
    state: { locale: "en", owner: "EXTERNAL" } as never,
    window: { window: () => null } as never,
    backend: { recovery: { cancel: () => events.push("cancel-retry") } } as never,
    supervisor: {
      copyDatabase: async (source: string, target: string) => {
        copyRequests.push([source, target]);
        // L-10: the record naming the copy exists before the first byte is copied.
        const open = await journal.findInProgress();
        if (open) {
          openRecords.push(open);
          events.push("journaled");
        }
        return { outcome: "checked", result: { type: "copy-result", status: "ok", identity: IDENTITY } };
      },
    } as never,
    storage: {
      classify: async (path: string) => {
        classified.push(path);
        return { risk: options.targetRisk ?? "none", evidence: [], symlinked: false };
      },
    } as never,
    prepareRuntime: async () => undefined,
    autoConfirm: true,
    log: () => undefined,
  });
  return { runner, events, classified, copyRequests, journal, openRecords };
}

describe("the target folder of the copy", () => {
  it.each(["network", "removable", "cloud-sync"] as const)(
    "refuses a folder on %s storage, before asking anything",
    async (risk) => {
      const { runner, events, classified, copyRequests } = runnerHarness({ targetRisk: risk });
      const switched = vi.fn();
      expect(await runner("/synthetic/source.sqlite", switched)).toMatchObject({
        ok: false,
        failure: "target-risky",
        errorCode: "COPY_TARGET_RISKY",
      });
      expect(classified).toHaveLength(1);
      expect(copyRequests).toEqual([]);
      expect(switched).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    },
  );

  it.each(["none", "unknown"] as const)("goes on when the folder is %s", async (risk) => {
    const { runner, copyRequests } = runnerHarness({ targetRisk: risk });
    expect(await runner("/synthetic/source.sqlite", async () => ({ ok: true }))).toMatchObject({ ok: true });
    expect(copyRequests).toHaveLength(1);
  });

  it("journals the copy path before copying and closes the record afterwards (L-10)", async () => {
    const done = runnerHarness();
    await done.runner("/synthetic/source.sqlite", async () => ({ ok: true }));
    expect(done.events).toContain("journaled");
    const open = done.openRecords[0]!;
    expect(open.details?.[COPY_PATH_DETAIL]).toBe(done.copyRequests[0]?.[1]);
    expect(await done.journal.get(open.operationId)).toMatchObject({ kind: "change-db", status: "completed" });
    expect(await done.journal.findInProgress()).toBeNull();

    const failed = runnerHarness();
    await failed.runner("/synthetic/source.sqlite", async () => ({ ok: false, busy: false, code: "X" }) as never);
    expect(await failed.journal.get(failed.openRecords[0]!.operationId)).toMatchObject({ status: "failed" });
  });

  it("tries again to close the record when the first close fails, so a live copy is never left as an orphan", async () => {
    const harness = runnerHarness();
    const finish = vi.spyOn(harness.journal, "finish");
    finish.mockRejectedValueOnce(new Error("EIO")).mockRejectedValueOnce(new Error("EIO"));
    await harness.runner("/synthetic/source.sqlite", async () => ({ ok: true }));
    expect(finish).toHaveBeenCalledTimes(3);
    expect(await harness.journal.findInProgress()).toBeNull();
  });

  it("cancels a pending automatic retry only once the user confirmed the copy", async () => {
    const confirmed = runnerHarness();
    await confirmed.runner("/synthetic/source.sqlite", async () => ({ ok: true }));
    expect(confirmed.events).toEqual(["cancel-retry", "journaled"]);
  });
});

function copyHarness(options: { running: boolean; switchOutcome: { ok: false; code: string }; restart?: boolean }) {
  const events: string[] = [];
  let running = options.running ? { port: 1 } : undefined;
  const recorded: string[] = [];
  const copy = createLocalCopy({
    state: { locale: "en", databasePath: () => "/synthetic/db.sqlite", candidates: { get: () => undefined } } as never,
    paths: { settingsFile: "/synthetic/settings.json" } as never,
    info: { snapshot: async () => ({}) } as never,
    backend: {
      start: async (kind: string) => {
        events.push(`start-${kind}`);
        if (kind === "restart") {
          if (options.restart) running = { port: 1 };
          return options.restart ? { ok: true } : { ok: false, code: "CHILD_EXITED" };
        }
        running = undefined;
        return options.switchOutcome;
      },
      presenter: () => ({
        clear: () => events.push("clear"),
        present: (code: string) => events.push(`present ${code}`),
      }),
    } as never,
    supervisor: {
      get running() {
        return running;
      },
    } as never,
    success: {
      opens: () => 0,
      finish: (outcome: { ok: boolean; code?: string }) => recorded.push(outcome.ok ? "ok" : (outcome.code ?? "")),
    } as never,
    runner: async (_source, switchTo) => {
      const outcome = await switchTo("/synthetic/copy.sqlite", IDENTITY);
      return outcome.ok || outcome.busy
        ? { ok: true, target: "/synthetic/copy.sqlite" }
        : {
            ok: false,
            reason: "failed",
            failure: "start-failed",
            errorCode: "COPY_START_FAILED",
            backendCode: outcome.code,
          };
    },
    log: () => undefined,
  });
  return { copy, events, recorded };
}

describe("a switch to the copy that fails", () => {
  it("records and shows the backend's own code, and brings the previous database back when it was serving", async () => {
    const { copy, events, recorded } = copyHarness({
      running: true,
      switchOutcome: { ok: false, code: "SCHEMA_TOO_NEW" },
      restart: true,
    });
    const result = await copy(undefined);
    expect(result).toEqual({ ok: false, reason: "failed", errorCode: "SCHEMA_TOO_NEW", message: expect.any(String) });
    // The real error comes with the reassurance that the settings and the original are unchanged.
    expect(result.ok ? "" : result.message).toContain("The original file was not changed.");
    expect(recorded).toEqual(["SCHEMA_TOO_NEW"]);
    expect(events).toEqual(["start-change-db", "start-restart", "clear"]);
  });

  it("presents the code when the previous database cannot come back, or nothing was serving", async () => {
    const stuck = copyHarness({ running: true, switchOutcome: { ok: false, code: "SCHEMA_TOO_NEW" } });
    expect(await stuck.copy(undefined)).toMatchObject({ errorCode: "SCHEMA_TOO_NEW" });
    expect(stuck.events).toEqual(["start-change-db", "start-restart", "present SCHEMA_TOO_NEW"]);
    const idle = copyHarness({ running: false, switchOutcome: { ok: false, code: "DB_PERMISSION" } });
    expect(await idle.copy(undefined)).toMatchObject({ errorCode: "DB_PERMISSION" });
    expect(idle.events).toEqual(["start-change-db", "present DB_PERMISSION"]);
  });
});

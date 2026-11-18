import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COPY_PATH_DETAIL,
  InMemoryOperationJournalStore,
  OPERATION_KINDS,
  OperationJournal,
  describeRecovery,
  isOwnCopyPath,
  runStartupRecovery,
  settleOrphanCopy,
  type CopySettlement,
  type OperationJournalFile,
  type OperationJournalStore,
  type OperationKind,
  type OperationRecord,
  type ProbeReport,
  type ServiceOwnerState,
} from "../../packages/desktop-core/src/index.js";
import { DB_A, DB_B, makeClock, newInput, probe } from "./operations-helpers.js";

/**
 * Start-up recovery: what the App does with an operation a crash left in progress. The decision table below walks every
 * operation kind through every phase; the rest covers the cost of an empty journal, the copy cleanup and the notices.
 */

const PATH: Record<string, ServiceOwnerState[]> = {
  PREPARING: ["PREPARING"],
  QUIESCING: ["PREPARING", "QUIESCING"],
  STARTING: ["PREPARING", "QUIESCING", "STARTING"],
  MANAGED: ["PREPARING", "QUIESCING", "STARTING", "MANAGED"],
};

const noCopy = async (): Promise<CopySettlement> => "absent";

/** A store that counts how often the journal file would be read or written. */
class CountingStore implements OperationJournalStore {
  loads = 0;
  saves = 0;
  private readonly inner = new InMemoryOperationJournalStore();
  async load(): Promise<OperationJournalFile | null> {
    this.loads += 1;
    return this.inner.load();
  }
  async save(file: OperationJournalFile): Promise<void> {
    this.saves += 1;
    await this.inner.save(file);
  }
}

async function journalWith(
  kind: OperationKind,
  phase: keyof typeof PATH,
  extra: Partial<Parameters<typeof newInput>[0]> = {},
  store: OperationJournalStore = new InMemoryOperationJournalStore(),
): Promise<OperationJournal> {
  const journal = new OperationJournal(store, makeClock());
  await journal.begin(newInput({ kind, ...extra }));
  for (const state of PATH[phase] ?? []) await journal.enterPhase("op-1", state);
  return journal;
}

function run(journal: OperationJournal, report: ProbeReport | (() => ProbeReport), settle = noCopy) {
  const probeFn = vi.fn(typeof report === "function" ? report : () => report);
  return {
    probeFn,
    result: runStartupRecovery({ journal, probe: probeFn, settleCopy: settle, log: () => undefined }),
  };
}

describe("start-up recovery with nothing to recover", () => {
  it("reads the journal once, never probes and never writes (the cost of an empty journal)", async () => {
    const store = new CountingStore();
    const journal = new OperationJournal(store, makeClock());
    const { probeFn, result } = run(journal, probe());
    const started = performance.now();
    expect(await result).toEqual({ closed: 0, holdStart: false });
    const elapsedMs = performance.now() - started;
    expect(probeFn).not.toHaveBeenCalled();
    expect(store.loads).toBe(1);
    expect(store.saves).toBe(0);
    // Benchmark note: with the probe and every write skipped, the whole pass is one in-memory read (well under a
    // millisecond here). The bound is deliberately generous only against CI scheduling noise, not against the work: a
    // probe or an fsync per start would be the single file read this pass is allowed to cost, repeated.
    expect(elapsedMs).toBeLessThan(250);
  });

  it("does not probe when every record is already closed", async () => {
    const store = new CountingStore();
    const journal = await journalWith("takeover", "MANAGED", {}, store);
    await journal.finish("op-1", "completed", {});
    const savesBefore = store.saves;
    const loadsBefore = store.loads;
    const { probeFn, result } = run(journal, probe());
    expect(await result).toEqual({ closed: 0, holdStart: false });
    expect(probeFn).not.toHaveBeenCalled();
    expect(store.saves).toBe(savesBefore);
    expect(store.loads).toBe(loadsBefore); // already cached in memory: no second read
  });

  it("changes nothing and claims nothing when the journal cannot be read", async () => {
    const failing: OperationJournalStore = {
      load: async () => {
        throw new Error("EIO");
      },
      save: async () => undefined,
    };
    const { probeFn, result } = run(new OperationJournal(failing, makeClock()), probe());
    expect(await result).toEqual({ closed: 0, holdStart: false });
    expect(probeFn).not.toHaveBeenCalled();
  });
});

describe("start-up recovery decision table (every kind x phase)", () => {
  const PHASES = ["PREPARING", "QUIESCING", "STARTING", "MANAGED"] as const;
  const details: Partial<Record<OperationKind, Record<string, number>>> = { "change-port": { from: 3210, to: 43_210 } };

  for (const kind of OPERATION_KINDS) {
    for (const phase of PHASES) {
      it(`${kind} interrupted in ${phase} is closed from the real state and never restarts the old service`, async () => {
        const journal = await journalWith(kind, phase, { details: details[kind], previousOwner: "MANAGED" });
        const { probeFn, result } = run(
          journal,
          probe({ oldServiceRunning: false, oldServiceRegistered: false, settingsPort: 3210, settingsState: "active" }),
        );
        const outcome = await result;
        expect(probeFn).toHaveBeenCalledTimes(1);
        expect(outcome.closed).toBe(1);
        const record = (await journal.get("op-1")) as OperationRecord;
        expect(record.status).not.toBe("in-progress");
        expect(await journal.findInProgress()).toBeNull();
        // nothing was claimed as restored: the App never starts the old login service by itself
        if (record.status === "cancelled") expect(record.recoveryPolicy).toBe("restore-previous");
        expect(outcome.holdStart).toBe(record.status === "failed");
      });
    }
  }

  it("holds the start (repair-only) when the state cannot be told: a child still runs, or the probe throws", async () => {
    const running = await journalWith("takeover", "STARTING", { previousOwner: "MANAGED" });
    const first = await run(
      running,
      probe({ desktopChild: { running: true, identityVerified: true }, settingsState: "active" }),
    ).result;
    expect(first.holdStart).toBe(true);
    expect((await running.get("op-1"))?.status).toBe("failed"); // resume cannot be carried out at start-up

    const thrown = await journalWith("change-db", "STARTING", { previousOwner: "MANAGED" });
    const second = await run(thrown, () => {
      throw new Error("probe failed");
    }).result;
    expect(second.holdStart).toBe(true);
    expect((await thrown.get("op-1"))?.status).toBe("failed");
  });

  it("closes an interrupted ordinary start silently when the settings are absent or hold its result", async () => {
    for (const settingsState of ["absent", "active"] as const) {
      const journal = await journalWith("takeover", "STARTING", { previousOwner: "UNCONFIGURED" });
      const outcome = await run(journal, probe({ settingsState, oldServiceRegistered: false })).result;
      expect(outcome.holdStart).toBe(false);
      expect(await journal.pendingNotices()).toEqual([]);
    }
  });

  it("port change: the settings name the old port -> kept; the new port -> applied; neither -> repair", async () => {
    const cases: [number | null, string, boolean][] = [
      [3210, "port-kept", false],
      [43_210, "port-applied", false],
      [4000, "needs-repair", true],
      [null, "needs-repair", true],
    ];
    for (const [settingsPort, kind, hold] of cases) {
      const journal = await journalWith("change-port", "STARTING", {
        previousOwner: "MANAGED",
        details: { from: 3210, to: 43_210 },
      });
      const outcome = await run(journal, probe({ settingsPort, settingsState: "active" })).result;
      const [notice] = await journal.pendingNotices();
      expect(notice?.recoveryNotice).toMatchObject({ kind, operation: "change-port", acknowledged: false });
      expect(outcome.holdStart).toBe(hold);
    }
  });

  it("database switch: the settings name the previous database -> kept; the target -> applied; unknown -> repair", async () => {
    const cases: [ProbeReport["dbIdentity"], string, boolean][] = [
      [DB_B, "db-kept", false],
      [DB_A, "db-applied", false],
      [null, "needs-repair", true],
    ];
    for (const [dbIdentity, kind, hold] of cases) {
      const journal = await journalWith("change-db", "STARTING", { previousOwner: "MANAGED", selectedDb: DB_A });
      const outcome = await run(journal, probe({ dbIdentity, settingsState: "active" })).result;
      const [notice] = await journal.pendingNotices();
      expect(notice?.recoveryNotice?.kind).toBe(kind);
      expect(outcome.holdStart).toBe(hold);
    }
  });

  it("restore with work to do becomes repair-only: the old service is never started by the App", async () => {
    const journal = await journalWith("restore", "QUIESCING", { previousOwner: "EXTERNAL" });
    const outcome = await run(journal, probe({ oldServiceRegistered: true, oldServiceEnabled: true })).result;
    const record = (await journal.get("op-1")) as OperationRecord;
    expect(outcome.holdStart).toBe(true);
    expect(record.status).toBe("failed");
    expect(record.recoveryNotice?.kind).toBe("needs-repair");
  });

  it("a migration that started is repair-only whatever the kind", async () => {
    const journal = await journalWith("change-db", "STARTING", { previousOwner: "MANAGED" });
    await journal.markMigrationStarted("op-1");
    const outcome = await run(journal, probe({ migrationEvidence: true })).result;
    expect(outcome.holdStart).toBe(true);
    expect((await journal.get("op-1"))?.migrationStarted).toBe(true);
  });

  it("legacy disable: still installed -> legacy-present (start held by the installed service, no repair)", async () => {
    const journal = await journalWith("legacy-disable", "STARTING", { previousOwner: "MANAGED" });
    const outcome = await run(journal, probe({ oldServiceRegistered: true, settingsState: "active" })).result;
    expect(outcome.holdStart).toBe(false);
    expect((await journal.pendingNotices())[0]?.recoveryNotice?.kind).toBe("legacy-present");
  });
});

describe("the copy to the local disk (L-10)", () => {
  const copyDetails = (copyPath: string) => ({ [COPY_PATH_DETAIL]: copyPath });

  it("closes the copy record by settling the copy, without probing the service", async () => {
    const journal = await journalWith("change-db", "PREPARING", { details: copyDetails("/synthetic/copy.sqlite") });
    const settle = vi.fn(async () => "removed" as CopySettlement);
    const { probeFn, result } = run(journal, probe(), settle);
    expect(await result).toEqual({ closed: 1, holdStart: false });
    expect(settle).toHaveBeenCalledWith("/synthetic/copy.sqlite");
    expect(probeFn).not.toHaveBeenCalled();
    expect((await journal.get("op-1"))?.recoveryNotice?.kind).toBe("copy-removed");
  });

  it("closes silently when the settings use the copy or nothing was left", async () => {
    for (const settlement of ["in-use", "absent", "refused"] as const) {
      const journal = await journalWith("change-db", "PREPARING", { details: copyDetails("/synthetic/c.sqlite") });
      await run(journal, probe(), async () => settlement).result;
      expect(await journal.findInProgress()).toBeNull();
      expect(await journal.pendingNotices()).toEqual([]);
    }
  });

  it("treats a settle that throws as refused and still closes the record", async () => {
    const journal = await journalWith("change-db", "PREPARING", { details: copyDetails("/synthetic/c.sqlite") });
    await run(journal, probe(), async () => {
      throw new Error("EACCES");
    }).result;
    expect(await journal.findInProgress()).toBeNull();
  });
});

describe("settleOrphanCopy containment", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function copyFolder(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "wi-copy-"));
    dirs.push(dir);
    return dir;
  }
  const platform = process.platform;

  it("removes an unused copy with its WAL, shared-memory and journal files", async () => {
    const dir = await copyFolder();
    const copy = path.join(dir, "work-intelligence-local-2.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await writeFile(`${copy}${suffix}`, "x");
    await writeFile(path.join(dir, "work-intelligence-local.sqlite"), "keep");
    const outcome = await settleOrphanCopy({
      copyPath: copy,
      copyDirectory: dir,
      settingsDatabasePaths: [path.join(dir, "work-intelligence-local.sqlite")],
      platform,
    });
    expect(outcome).toBe("removed");
    expect(await readdir(dir)).toEqual(["work-intelligence-local.sqlite"]);
  });

  it("keeps a copy the settings name, and reports absent when it is already gone", async () => {
    const dir = await copyFolder();
    const copy = path.join(dir, "work-intelligence-local.sqlite");
    await writeFile(copy, "x");
    expect(
      await settleOrphanCopy({ copyPath: copy, copyDirectory: dir, settingsDatabasePaths: [null, copy], platform }),
    ).toBe("in-use");
    expect(await readdir(dir)).toEqual(["work-intelligence-local.sqlite"]);
    await rm(copy);
    expect(await settleOrphanCopy({ copyPath: copy, copyDirectory: dir, settingsDatabasePaths: [], platform })).toBe(
      "absent",
    );
  });

  it("refuses anything outside the copy folder or not named like a copy, and touches nothing", async () => {
    const dir = await copyFolder();
    const other = await copyFolder();
    const outside = path.join(other, "work-intelligence-local.sqlite");
    const wrongName = path.join(dir, "notes.sqlite");
    const traversal = path.join(dir, "..", path.basename(other), "work-intelligence-local.sqlite");
    for (const file of [outside, wrongName]) await writeFile(file, "precious");
    for (const copyPath of [outside, wrongName, traversal, "relative.sqlite", ""]) {
      expect(await settleOrphanCopy({ copyPath, copyDirectory: dir, settingsDatabasePaths: [], platform })).toBe(
        "refused",
      );
    }
    expect(await readdir(other)).toEqual(["work-intelligence-local.sqlite"]);
    expect(await readdir(dir)).toEqual(["notes.sqlite"]);
    expect(isOwnCopyPath(path.join(dir, "work-intelligence-local-12.sqlite"), dir, platform)).toBe(true);
    expect(isOwnCopyPath(path.join(dir, "sub", "work-intelligence-local.sqlite"), dir, platform)).toBe(false);
  });

  it("refuses a folder or a symlink with a copy's name", async () => {
    const dir = await copyFolder();
    const folder = path.join(dir, "work-intelligence-local.sqlite");
    await mkdir(folder);
    expect(await settleOrphanCopy({ copyPath: folder, copyDirectory: dir, settingsDatabasePaths: [], platform })).toBe(
      "refused",
    );
    if (process.platform === "win32") return;
    const target = await copyFolder();
    const precious = path.join(target, "precious.txt");
    await writeFile(precious, "x");
    const link = path.join(dir, "work-intelligence-local-2.sqlite");
    await symlink(precious, link);
    expect(await settleOrphanCopy({ copyPath: link, copyDirectory: dir, settingsDatabasePaths: [], platform })).toBe(
      "refused",
    );
    expect(await readdir(target)).toEqual(["precious.txt"]);
  });
});

describe("describeRecovery", () => {
  const record = async (kind: OperationKind, extra = {}): Promise<OperationRecord> =>
    (await (await journalWith(kind, "STARTING", extra)).get("op-1")) as OperationRecord;
  const decision = (action: "none" | "repair") =>
    ({
      nextState: action === "none" ? "MANAGED" : "NEEDS_REPAIR",
      action,
      recoveryPolicy: "restore-previous",
      migrationStarted: false,
      restore: null,
      reason: "r",
    }) as const;

  it("says nothing for an ordinary start and something for every repair", async () => {
    expect(describeRecovery(await record("takeover"), decision("none"), probe()())).toBeNull();
    expect(describeRecovery(await record("restart"), decision("none"), probe()())).toBeNull();
    for (const kind of OPERATION_KINDS) {
      expect(describeRecovery(await record(kind), decision("repair"), probe()())?.kind).toBe("needs-repair");
    }
    expect(describeRecovery(await record("takeover"), decision("none"), null)?.kind).toBe("needs-repair");
  });

  it("names the Agent setup that was interrupted", async () => {
    expect(describeRecovery(await record("apply-agent"), decision("none"), probe()())?.kind).toBe("agent-interrupted");
  });
});

describe("recovery notices in the journal", () => {
  it("stores the notice in the write that closes the record, lists it newest first and acknowledges it once", async () => {
    const journal = await journalWith("change-port", "STARTING", {
      previousOwner: "MANAGED",
      details: { from: 3210, to: 43_210 },
    });
    await run(journal, probe({ settingsPort: 3210, settingsState: "active" })).result;
    const [pending] = await journal.pendingNotices();
    expect(pending).toMatchObject({ operationId: "op-1", status: "interrupted" });
    expect(pending?.recoveryNotice).toMatchObject({ kind: "port-kept", port: 3210, attemptedPort: 43_210 });
    expect(await journal.acknowledgeNotice("op-1")).toBe(true);
    expect(await journal.pendingNotices()).toEqual([]);
    expect(await journal.acknowledgeNotice("op-1")).toBe(false);
    expect(await journal.acknowledgeNotice("missing")).toBe(false);
  });
});

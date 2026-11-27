import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileOperationJournalStore,
  InMemoryOperationJournalStore,
  InvalidTransitionError,
  JournalStoreError,
  OperationJournal,
  RestoreForbiddenError,
  UnknownOperationError,
  operationRecordSchema,
  type OperationJournalFile,
  type OperationJournalStore,
} from "../../packages/desktop-core/src/index.js";
import { writeFileAtomic } from "../../packages/desktop-core/src/internal/atomic-file.js";
import { makeClock, newInput } from "./operations-helpers.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wi-ops-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function memoryJournal(
  store: OperationJournalStore = new InMemoryOperationJournalStore(),
  max?: number,
): OperationJournal {
  return new OperationJournal(store, makeClock(), max);
}

describe("OperationJournal", () => {
  it("begins an operation at the previous owner with restore-previous policy and is idempotent", async () => {
    const journal = memoryJournal();
    const first = await journal.begin(newInput());
    expect(first).toMatchObject({
      phase: "EXTERNAL",
      recoveryPolicy: "restore-previous",
      migrationStarted: false,
      status: "in-progress",
    });
    const again = await journal.begin(newInput({ kind: "restore" }));
    expect(again).toBe(first);
    expect(operationRecordSchema.safeParse(first).success).toBe(true);
  });

  it("forces repair-only when begun with migrationStarted", async () => {
    const record = await memoryJournal().begin(newInput({ migrationStarted: true }));
    expect(record.recoveryPolicy).toBe("repair-only");
  });

  it("applies the same (operationId, step) twice without changing state", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    await journal.enterPhase("op-1", "PREPARING");
    const first = await journal.completeStep("op-1", "preflight");
    const second = await journal.completeStep("op-1", "preflight");
    expect(second).toBe(first);
    expect(second.completedSteps).toEqual(["preflight"]);
    await journal.completeStep("op-1", "stop-old");
    const third = await journal.enterPhase("op-1", "QUIESCING");
    expect(third.phase).toBe("QUIESCING");
  });

  it("enterPhase is a no-op for the current phase and rejects illegal edges", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    const same = await journal.enterPhase("op-1", "EXTERNAL");
    expect(same.phase).toBe("EXTERNAL");
    await expect(journal.enterPhase("op-1", "MANAGED")).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("keeps the first result of a repeated step", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    await journal.completeStep("op-1", "s", { n: 1 });
    const record = await journal.completeStep("op-1", "s", { n: 2 });
    expect(record.stepResults).toEqual({ s: { n: 1 } });
    expect((await journal.completeStep("op-1", "t")).stepResults.t).toBeNull();
  });

  it("migrationStarted is monotonic, forces repair-only and blocks restore", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    await journal.enterPhase("op-1", "PREPARING");
    await journal.completeStep("op-1", "a");
    await journal.enterPhase("op-1", "QUIESCING");
    await journal.completeStep("op-1", "b");
    const started = await journal.markMigrationStarted("op-1");
    expect(started).toMatchObject({ migrationStarted: true, recoveryPolicy: "repair-only" });
    expect(await journal.markMigrationStarted("op-1")).toBe(started);
    await expect(journal.enterPhase("op-1", "EXTERNAL")).rejects.toBeInstanceOf(RestoreForbiddenError);
    const stillStarted = await journal.enterPhase("op-1", "NEEDS_REPAIR");
    expect(stillStarted.migrationStarted).toBe(true);
    const done = await journal.finish("op-1", "failed", { error: "x" });
    expect(done.migrationStarted).toBe(true);
  });

  it("closes a recovery decision of action none as interrupted with the recovered state", async () => {
    const store = new InMemoryOperationJournalStore();
    const journal = memoryJournal(store, 1);
    await journal.begin(newInput());
    const closed = await journal.applyRecovery("op-1", {
      nextState: "EXTERNAL",
      action: "none",
      recoveryPolicy: "restore-previous",
      migrationStarted: false,
      restore: null,
      reason: "state is consistent",
    });
    expect(closed).toMatchObject({
      status: "interrupted",
      result: { recoveredState: "EXTERNAL", reason: "state is consistent" },
    });
    expect(await journal.findInProgress()).toBeNull();
    await journal.begin(newInput({ operationId: "op-2" }));
    await journal.finish("op-2", "completed");
    await journal.begin(newInput({ operationId: "op-3" }));
    await journal.finish("op-3", "completed");
    expect((await store.load())?.records.map((r) => r.operationId)).toEqual(["op-3"]);
  });

  it("persists a cancel request only on in-progress records and loads old journals without the field", async () => {
    const store = new InMemoryOperationJournalStore();
    const journal = memoryJournal(store);
    await journal.begin(newInput());
    expect((await journal.requestCancel("op-1")).cancelRequested).toBe(true);
    await journal.finish("op-1", "failed", { error: "x" });
    await journal.begin(newInput({ operationId: "op-2" }));
    await journal.finish("op-2", "completed");
    expect((await journal.requestCancel("op-2")).cancelRequested).toBe(false);
    const file = JSON.parse(JSON.stringify(await store.load())) as { records: Record<string, unknown>[] };
    for (const record of file.records) delete record.cancelRequested;
    await store.save(file as never);
    expect((await memoryJournal(store).get("op-1"))?.cancelRequested).toBe(false);
  });

  it("terminal records are immutable", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    const done = await journal.finish("op-1", "completed", { result: { ok: true } });
    expect(await journal.finish("op-1", "failed", { error: "late" })).toBe(done);
    expect(done.result).toEqual({ ok: true });
    expect(await journal.findInProgress()).toBeNull();
  });

  it("throws UnknownOperationError and finds the in-progress record", async () => {
    const journal = memoryJournal();
    await expect(journal.enterPhase("nope", "PREPARING")).rejects.toBeInstanceOf(UnknownOperationError);
    expect(await journal.get("nope")).toBeNull();
    await journal.begin(newInput());
    expect((await journal.findInProgress())?.operationId).toBe("op-1");
  });

  it("prunes old terminal records but never in-progress ones", async () => {
    const store = new InMemoryOperationJournalStore();
    const journal = memoryJournal(store, 2);
    for (const id of ["a", "b", "c"]) {
      await journal.begin(newInput({ operationId: id }));
      await journal.finish(id, "completed");
    }
    await journal.begin(newInput({ operationId: "live" }));
    const file = await store.load();
    expect(file?.records.map((record) => record.operationId)).toEqual(["b", "c", "live"]);
  });

  it("serializes concurrent mutations", async () => {
    const journal = memoryJournal();
    await journal.begin(newInput());
    await Promise.all(["s1", "s2", "s3", "s4"].map((step) => journal.completeStep("op-1", step)));
    expect((await journal.get("op-1"))?.completedSteps.slice().sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("rolls the in-memory record back when persisting fails", async () => {
    let failing = false;
    const inner = new InMemoryOperationJournalStore();
    const store: OperationJournalStore = {
      load: () => inner.load(),
      save: async (file: OperationJournalFile) => {
        if (failing) throw new Error("disk full");
        await inner.save(file);
      },
    };
    const journal = memoryJournal(store);
    await journal.begin(newInput());
    failing = true;
    await expect(journal.completeStep("op-1", "s")).rejects.toThrow("disk full");
    await expect(journal.begin(newInput({ operationId: "op-2" }))).rejects.toThrow("disk full");
    failing = false;
    expect((await journal.get("op-1"))?.completedSteps).toEqual([]);
    expect(await journal.get("op-2")).toBeNull();
  });

  it("surfaces a failing initial load and retries it later", async () => {
    let calls = 0;
    const inner = new InMemoryOperationJournalStore();
    const store: OperationJournalStore = {
      load: async () => {
        calls += 1;
        if (calls === 1) throw new JournalStoreError("unreadable", "boom");
        return inner.load();
      },
      save: (file) => inner.save(file),
    };
    const journal = memoryJournal(store);
    await expect(journal.get("x")).rejects.toBeInstanceOf(JournalStoreError);
    expect(await journal.get("x")).toBeNull();
  });
});

describe("FileOperationJournalStore", () => {
  it("reads ENOENT as no journal, round-trips with mode 0o600 and leaves no temp files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "journal.json");
    const store = new FileOperationJournalStore(file);
    expect(await store.load()).toBeNull();
    const journal = new OperationJournal(store, makeClock());
    await journal.begin(newInput());
    await journal.enterPhase("op-1", "PREPARING");
    const reopened = new OperationJournal(new FileOperationJournalStore(file), makeClock());
    expect((await reopened.get("op-1"))?.phase).toBe("PREPARING");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["journal.json"]);
  });

  it("quarantines corrupt JSON and schema violations, then starts empty", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "journal.json");
    const quarantined: { from: string; to: string; reason: string }[] = [];
    let tick = 0;
    const store = new FileOperationJournalStore(file, {
      onQuarantine: (q) => quarantined.push(q),
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const contents = ["{not json", "{}", JSON.stringify({ journalVersion: 1, records: [{ operationId: "x" }] })];
    for (const content of contents) {
      await writeFile(file, content);
      expect(await store.load()).toBeNull();
      expect(await readdir(dir)).not.toContain("journal.json");
    }
    expect(quarantined).toHaveLength(contents.length);
    const asides = (await readdir(dir)).filter((name) => name.startsWith("journal.json.corrupt-"));
    expect(asides).toHaveLength(contents.length);
    for (const q of quarantined) expect(path.basename(q.to).startsWith("journal.json.corrupt-")).toBe(true);
    expect(await readFile(quarantined[0]!.to, "utf8")).toBe("{not json");
    const journal = new OperationJournal(store, makeClock());
    await journal.begin(newInput());
    expect((await journal.get("op-1"))?.status).toBe("in-progress");
  });

  it("quarantines with the real clock when none is injected, and names a non-Error cause as unparseable", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "journal.json");
    const quarantined: { from: string; to: string; reason: string }[] = [];
    const store = new FileOperationJournalStore(file, { onQuarantine: (q) => quarantined.push(q) });
    await writeFile(file, "{not json");
    expect(await store.load()).toBeNull();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.reason).toBe("SyntaxError");
    expect(path.basename(quarantined[0]!.to)).toMatch(/^journal\.json\.corrupt-\d{4}-\d{2}-\d{2}T/);
    expect(await readdir(dir)).toEqual([path.basename(quarantined[0]!.to)]);
  });

  it("fails with 'invalid' when a corrupt journal cannot be moved aside, and leaves it in place", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "journal.json");
    await writeFile(file, "{not json");
    // A stamp with a path separator points the aside file into a folder that does not exist, so the rename fails.
    const clock = () => ({ toISOString: () => "missing-folder/stamp" }) as unknown as Date;
    const store = new FileOperationJournalStore(file, { clock });
    await expect(store.load()).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(file, "utf8")).toBe("{not json");
  });

  it("fails closed on a journal written by a newer version: it is not damaged, so it is neither moved nor emptied", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "journal.json");
    const quarantined: unknown[] = [];
    const store = new FileOperationJournalStore(file, { onQuarantine: (q) => quarantined.push(q) });
    const content = JSON.stringify({ journalVersion: 99, records: [] });
    await writeFile(file, content);
    await expect(store.load()).rejects.toMatchObject({ code: "newer-version" });
    expect(quarantined).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect(await readdir(dir)).toEqual(["journal.json"]);
  });

  it("records a quarantined journal as one closed record with a journal-unreadable notice", async () => {
    const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
    await journal.recordUnreadableJournal();
    const notices = await journal.pendingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.recoveryNotice).toMatchObject({ kind: "journal-unreadable", acknowledged: false });
    expect(notices[0]?.status).toBe("failed");
    expect(await journal.findInProgress()).toBeNull();
    expect(await journal.acknowledgeNotice(notices[0]!.operationId)).toBe(true);
    expect(await journal.pendingNotices()).toEqual([]);
  });

  it("fails closed when the path is unreadable (not ENOENT)", async () => {
    const dir = await tempDir();
    await expect(new FileOperationJournalStore(dir).load()).rejects.toMatchObject({ code: "unreadable" });
    if (process.platform !== "win32") {
      // POSIX reports ENOTDIR for a path through a regular file; Windows reports ENOENT (a missing journal).
      const blocker = path.join(dir, "file");
      await writeFile(blocker, "x");
      await expect(new FileOperationJournalStore(path.join(blocker, "journal.json")).load()).rejects.toMatchObject({
        code: "unreadable",
      });
    }
  });

  it("reports unwritable targets and cleans up its temp file", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "journal.json");
    await mkdir(target); // a directory cannot be replaced by rename
    const store = new FileOperationJournalStore(target);
    await expect(store.save({ journalVersion: 1, records: [] })).rejects.toMatchObject({ code: "unwritable" });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeFileAtomic", () => {
  it("replaces content atomically with the requested mode and tolerates an unsyncable directory", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two", { mode: 0o640 });
    expect(await readFile(target, "utf8")).toBe("two");
    if (process.platform !== "win32") {
      await chmod(dir, 0o700);
      expect((await stat(target)).mode & 0o777).toBe(0o640);
    }
  });
});

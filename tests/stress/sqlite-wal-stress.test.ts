import { mkdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { assessSqliteWalResetFix } from "@work-intelligence/shared/sqlite-version";
import {
  initializeWorkIntelligenceDatabase,
  restoreDatabase,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { BarrierSandbox, REPOSITORY_ROOT, type Waiter } from "../helpers/old-writer-barrier.js";
import {
  CHECKPOINT_MODES,
  createRandom,
  expectedEventCount,
  fingerprintDatabase,
  readStressRows,
  RESTORE_EXCLUDED_TABLES,
  WRITER_COUNT,
  type CheckpointMode,
} from "./stress-support.js";

// DT-07: multi-process WAL write + checkpoint stress. Evidence ALONGSIDE the SQLite WAL-reset patch check (DT-06,
// scripts/check-sqlite-version.mjs), never a replacement for it. Four writer processes write through the real
// WorkIntelligenceStore while two readers (one holding long read transactions), a checkpointer cycling all four
// wal_checkpoint modes and a VACUUM INTO snapshotter share the file; writers are SIGKILLed at seeded moments and
// respawned. Every correctness assertion is absolute. SQLITE_BUSY is only counted and reported (no threshold yet).
//
// Environment: WI_SQLITE_STRESS_SECONDS (load duration, default 45), WI_SQLITE_STRESS_SEED (default: random, printed).
// The seed reproduces the plan and write shapes (kill victims, think times, event counts), not the exact wall-clock kill moments.

const WORKER_SCRIPT = join(REPOSITORY_ROOT, "tests/stress/stress-worker.ts");
const MIN_DURATION_SECONDS = 3;
const DURATION_SECONDS = parseDurationSeconds(process.env.WI_SQLITE_STRESS_SECONDS);
const SEED = process.env.WI_SQLITE_STRESS_SEED
  ? Number(process.env.WI_SQLITE_STRESS_SEED) >>> 0
  : Math.floor(Math.random() * 2 ** 32);
/** Hard time box: the watchdog fires first (with diagnostics), vitest's own timeout stays beyond it. */
const WATCHDOG_MS = (DURATION_SECONDS + 150) * 1000;
const TEST_TIMEOUT_MS = (DURATION_SECONDS + 240) * 1000;
const RESULT_FILE = join(REPOSITORY_ROOT, "perf-results", `sqlite-stress-${process.platform}.json`);
const LOG_LINES = 25;

type Role = "writer" | "reader-long" | "reader-short" | "checkpointer" | "snapshotter";
type Message = { type: string; [key: string]: unknown };

interface Stats {
  ops: number;
  busy: number;
  otherErrors: number;
  extra: Record<string, number>;
}

interface Handle {
  name: string;
  role: Role;
  writer?: number;
  waiter: Waiter;
  log: string[];
  stats: Stats;
  closed: Promise<void>;
  finalReceived: boolean;
}

interface SnapshotRecord {
  index: number;
  path: string;
  before: number[];
  after?: number[];
}

interface CheckpointStat {
  calls: number;
  busyFlagged: number;
  thrownBusy: number;
  fullyCheckpointed: number;
  partial: number;
  logFramesTotal: number;
  logFramesMax: number;
  checkpointedFramesTotal: number;
}

interface KillRecord {
  writer: number;
  lastAckedSeq: number;
  inFlight: "committed" | "absent";
}

function parseDurationSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 45;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_DURATION_SECONDS) {
    throw new Error(
      `WI_SQLITE_STRESS_SECONDS must be a number >= ${MIN_DURATION_SECONDS} (got "${raw}"); the kill plan needs at least ${MIN_DURATION_SECONDS} s.`,
    );
  }
  return value;
}

/** Removes absolute POSIX/Windows/UNC paths and file:// URLs so a report never carries local paths or stack frames. */
function redactPaths(text: string): string {
  return text
    .replace(/file:\/\/[^\s)'"]*/gi, "<path>")
    .replace(/\\\\[^\s\\/)'"]+[\\/][^\s)'"]*/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s)'"]*/g, "<path>")
    .replace(/(^|[\s(='"])\/(?:[^\s/)'"]+\/)*[^\s/)'"]*/g, "$1<path>");
}

/** First line of an error only, paths redacted: assertion labels survive, stack traces and stderr dumps do not. */
function redactedFailure(failure: unknown): string {
  const text = String((failure as Error)?.message ?? failure);
  return redactPaths(text.split("\n")[0] ?? "").slice(0, 500);
}

function emptyStats(): Stats {
  return { ops: 0, busy: 0, otherErrors: 0, extra: {} };
}

function emptyCheckpointStat(): CheckpointStat {
  return {
    calls: 0,
    busyFlagged: 0,
    thrownBusy: 0,
    fullyCheckpointed: 0,
    partial: 0,
    logFramesTotal: 0,
    logFramesMax: 0,
    checkpointedFramesTotal: 0,
  };
}

function removeTree(path: string): void {
  // Windows can briefly keep -wal/-shm files locked right after a process exits.
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function integrityResult(db: DatabaseSync): string {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  return rows.map((row) => row.integrity_check).join("; ");
}

/** Absolute database checks shared by the live database, the snapshots and the restored database. */
function assertConsistent(db: DatabaseSync, label: string, options: { fts: boolean }): void {
  expect(integrityResult(db), `${label}: PRAGMA integrity_check`).toBe("ok");
  expect(db.prepare("PRAGMA foreign_key_check").all(), `${label}: PRAGMA foreign_key_check`).toEqual([]);
  if (!options.fts) return;
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
    sql: string | null;
  }>;
  const ftsTables = tables.filter((table) => /USING\s+fts5/i.test(table.sql ?? "")).map((table) => table.name);
  expect(ftsTables.length, `${label}: expected at least one FTS5 table`).toBeGreaterThan(0);
  for (const name of ftsTables) {
    // Throws "database disk image is malformed" when the FTS index disagrees with itself.
    db.exec(`INSERT INTO "${name}"("${name}") VALUES('integrity-check')`);
  }
}

/** Per writer the stored seqs must be exactly 1..k (gap-free) with every session's events complete. */
function assertPrefixes(db: DatabaseSync, label: string, low: number[], high: number[]): number[] {
  const rows = readStressRows(db);
  expect(rows.foreign, `${label}: sessions that are not stress writes`).toBe(0);
  const counts: number[] = [];
  for (let writer = 0; writer < WRITER_COUNT; writer += 1) {
    const seqs = rows.bySeq[writer] ?? new Map<number, number>();
    const k = seqs.size;
    counts.push(k);
    for (let seq = 1; seq <= k; seq += 1) {
      expect(seqs.has(seq), `${label}: writer ${writer} is missing seq ${seq} of ${k} (gap)`).toBe(true);
      expect(seqs.get(seq), `${label}: writer ${writer} seq ${seq} has torn events`).toBe(
        expectedEventCount(writer, seq),
      );
    }
    expect(k, `${label}: writer ${writer} has ${k} rows, below its acked mark ${low[writer]}`).toBeGreaterThanOrEqual(
      low[writer] ?? 0,
    );
    expect(k, `${label}: writer ${writer} has ${k} rows, above its upper mark ${high[writer]}`).toBeLessThanOrEqual(
      high[writer] ?? 0,
    );
  }
  return counts;
}

describe("SQLite WAL multi-process stress (DT-07)", () => {
  it(
    "keeps the database consistent under concurrent writers, readers, checkpoints, snapshots and SIGKILLs",
    async () => {
      const sandbox = new BarrierSandbox();
      const snapshotDirectory = join(sandbox.root, "snapshots");
      mkdirSync(snapshotDirectory, { recursive: true });
      const handles: Handle[] = [];
      const highWater: number[] = Array.from({ length: WRITER_COUNT }, () => 0);
      const snapshots: SnapshotRecord[] = [];
      const checkpoints = Object.fromEntries(CHECKPOINT_MODES.map((mode) => [mode, emptyCheckpointStat()])) as Record<
        CheckpointMode,
        CheckpointStat
      >;
      const kills: KillRecord[] = [];
      const fatals: string[] = [];
      const killPending = new Set<number>();
      const writerHandle = new Map<number, Handle>();
      const killTasks: Array<Promise<void>> = [];
      let stopping = false;
      let loadStartedAt = 0;
      let loadSeconds = 0;
      let failure: unknown;
      const sharedRandom = createRandom(SEED);
      const writerRandom = Array.from({ length: WRITER_COUNT }, (_unused, writer) =>
        createRandom(SEED ^ ((writer + 1) * 977)),
      );

      const sqlite = new DatabaseSync(":memory:");
      const sqliteVersion = (sqlite.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
      sqlite.close();
      const assessment = assessSqliteWalResetFix(sqliteVersion);
      console.log(
        `[sqlite-stress] seed=${SEED} duration=${DURATION_SECONDS}s platform=${process.platform} node=${process.versions.node} ` +
          `sqlite_version()=${sqliteVersion} walResetFixed=${!assessment.affected}` +
          `${assessment.fixedIn ? ` (fix on this line: ${assessment.fixedIn})` : ""} recognized=${assessment.recognized}`,
      );

      let dumped = false;
      function dumpDiagnostics(reason: string): void {
        if (dumped) return;
        dumped = true;
        const lines = [`[sqlite-stress] WATCHDOG: ${reason}`, `seed=${SEED} high-water=${highWater.join(",")}`];
        for (const handle of handles) {
          lines.push(
            `--- ${handle.name} (pid ${handle.waiter.child.pid}, exit=${handle.waiter.child.exitCode ?? "running"}) last log lines:`,
            ...handle.log.slice(-LOG_LINES),
            `stderr: ${handle.waiter.stderr().split("\n").slice(-LOG_LINES).join(" | ")}`,
          );
        }
        console.error(lines.join("\n"));
      }

      let rejectWatchdog: (error: Error) => void = () => undefined;
      const watchdogFired = new Promise<never>((_resolve, reject) => (rejectWatchdog = reject));
      const watchdog = setTimeout(() => {
        const reason = `no completion after ${WATCHDOG_MS / 1000}s`;
        dumpDiagnostics(reason);
        for (const handle of handles) {
          handle.waiter.markKilled();
          handle.waiter.child.kill("SIGKILL");
        }
        rejectWatchdog(new Error(`Stress watchdog: ${reason}; see the dumped process logs.`));
      }, WATCHDOG_MS);

      function spawn(role: Role, name: string, config: Record<string, unknown>, writer?: number): Handle {
        const waiter = sandbox.spawnIpc(WORKER_SCRIPT, [
          role,
          JSON.stringify({
            databasePath: sandbox.databasePath,
            projectRoot: sandbox.projectRoot,
            seed: SEED,
            ...config,
          }),
        ]);
        const handle: Handle = {
          name,
          role,
          writer,
          waiter,
          log: [],
          stats: emptyStats(),
          finalReceived: false,
          // 'disconnect' comes after every IPC message was delivered; 'exit' after the process ended.
          closed: Promise.all([
            new Promise<void>((resolve) => waiter.child.once("disconnect", () => resolve())),
            waiter.exited,
          ]).then(() => undefined),
        };
        handles.push(handle);
        waiter.child.on("message", (message: Message) => onMessage(handle, message));
        waiter.child.stderr?.on("data", (chunk: Buffer) => handle.log.push(`stderr: ${chunk.toString().trim()}`));
        return handle;
      }

      function onMessage(handle: Handle, message: Message): void {
        switch (message.type) {
          case "log":
            handle.log.push(String(message.text));
            if (handle.log.length > 200) handle.log.splice(0, 100);
            break;
          case "stats":
          case "final": {
            handle.stats = {
              ops: Number(message.ops),
              busy: Number(message.busy),
              otherErrors: Number(message.otherErrors),
              extra: (message.extra as Record<string, number>) ?? {},
            };
            handle.log.push(
              `${String(message.type)} ops=${handle.stats.ops} busy=${handle.stats.busy} errors=${handle.stats.otherErrors}`,
            );
            if (message.type === "final") handle.finalReceived = true;
            break;
          }
          case "fatal":
            fatals.push(`${handle.name}: ${String(message.context)}: ${String(message.error)}`);
            break;
          case "ack-failed":
            fatals.push(`${handle.name}: write ${String(message.seq)} failed permanently`);
            break;
          case "ack": {
            const writer = Number(message.writer);
            const seq = Number(message.seq);
            if (seq !== (highWater[writer] ?? 0) + 1)
              fatals.push(`${handle.name}: ack ${seq} after ${highWater[writer]}`);
            highWater[writer] = seq;
            dispatch(writer);
            break;
          }
          case "checkpoint": {
            const stat = checkpoints[message.mode as CheckpointMode];
            stat.calls += 1;
            if (message.thrownBusy) stat.thrownBusy += 1;
            else {
              const log = Number(message.log);
              const done = Number(message.checkpointed);
              if (message.busy) stat.busyFlagged += 1;
              if (log === done) stat.fullyCheckpointed += 1;
              else stat.partial += 1;
              stat.logFramesTotal += Math.max(0, log);
              stat.logFramesMax = Math.max(stat.logFramesMax, log);
              stat.checkpointedFramesTotal += Math.max(0, done);
            }
            break;
          }
          case "snapshot-begin-request":
            snapshots.push({ index: Number(message.index), path: "", before: [...highWater] });
            handle.waiter.send({ type: "snapshot-begin", index: message.index });
            break;
          case "snapshot-end": {
            const record = snapshots.find((entry) => entry.index === Number(message.index));
            if (record) {
              record.path = String(message.path);
              // The writers run in lock step with this process, so at most one committed write per writer is still
              // unacknowledged here: the snapshot holds at most highWater + 1 rows of each writer.
              record.after = highWater.map((seq) => seq + 1);
            }
            break;
          }
          case "snapshot-failed": {
            const index = snapshots.findIndex((entry) => entry.index === Number(message.index));
            if (index >= 0) snapshots.splice(index, 1);
            break;
          }
          default:
            break;
        }
      }

      /** Sends the next "go" to a writer after a seeded think time, or arranges its SIGKILL when one is due. */
      function dispatch(writer: number): void {
        if (stopping) return;
        const random = writerRandom[writer] ?? sharedRandom;
        const think = random() < 0.6 ? 0 : 1 + Math.floor(random() * 6);
        const handle = writerHandle.get(writer);
        if (!handle) return;
        const send = (): void => {
          if (stopping || writerHandle.get(writer) !== handle || handle.waiter.killed) return;
          if (killPending.delete(writer)) {
            // Kill within ~15 ms of the write starting, so it often lands inside the transaction.
            handle.waiter.send({ type: "go" });
            const jitter = Math.floor(sharedRandom() * 150) / 10;
            killTasks.push(killAndRespawn(writer, handle, jitter));
          } else handle.waiter.send({ type: "go" });
        };
        if (think === 0) send();
        else setTimeout(send, think);
      }

      async function killAndRespawn(writer: number, handle: Handle, delayMs: number): Promise<void> {
        await sleep(delayMs);
        // Marked first so IPC to this child that races the kill is ignored instead of emitting an unhandled 'error'.
        handle.waiter.markKilled();
        handle.waiter.child.kill("SIGKILL");
        await handle.closed;
        const lastAcked = highWater[writer] ?? 0;
        // Before the retry can mask anything: the single in-flight write must be complete or absent, nothing beyond it.
        const db = new DatabaseSync(sandbox.databasePath, { readOnly: true });
        let inFlight: KillRecord["inFlight"];
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          const seqs = readStressRows(db).bySeq[writer] ?? new Map<number, number>();
          for (const seq of seqs.keys()) {
            expect(
              seq,
              `writer ${writer} killed: row for unacked seq ${seq} beyond the one in-flight write`,
            ).toBeLessThanOrEqual(lastAcked + 1);
          }
          const events = seqs.get(lastAcked + 1);
          if (events === undefined) inFlight = "absent";
          else {
            expect(events, `writer ${writer} killed: in-flight seq ${lastAcked + 1} is torn`).toBe(
              expectedEventCount(writer, lastAcked + 1),
            );
            inFlight = "committed";
          }
        } finally {
          db.close();
        }
        kills.push({ writer, lastAckedSeq: lastAcked, inFlight });
        // After the load ends, a committed-but-unacked write is still respawned and retried to its ack (below), so the final
        // state has acked == committed; an absent in-flight write needs no retry.
        if (stopping && inFlight === "absent") return;
        // Continue the sequence from the last acked seq + 1; an in-flight write that did commit is a harmless idempotent retry.
        const next = spawn(
          "writer",
          `writer-${writer}-incarnation-${kills.length}`,
          { writer, startSeq: lastAcked + 1 },
          writer,
        );
        writerHandle.set(writer, next);
        await next.waiter.waitFor("ready");
        if (!stopping) {
          dispatch(writer);
          return;
        }
        // Draining: retry exactly the committed in-flight seq and wait for its ack before the processes are stopped.
        next.waiter.send({ type: "go" });
        const deadline = Date.now() + 30_000;
        while ((highWater[writer] ?? 0) < lastAcked + 1) {
          if (fatals.length > 0 || next.waiter.child.exitCode !== null) break;
          if (Date.now() > deadline)
            throw new Error(`writer ${writer}: the retry of committed seq ${lastAcked + 1} was never acked`);
          await sleep(10);
        }
        expect(highWater[writer], `writer ${writer}: retried committed seq ${lastAcked + 1} acked exactly once`).toBe(
          lastAcked + 1,
        );
      }

      try {
        await Promise.race([
          watchdogFired,
          (async () => {
            const store = new WorkIntelligenceStore(sandbox.databasePath);
            try {
              const project = store.addProject("Stress", sandbox.projectRoot);
              store.updateProject(project.id, { status: "tracked" });
            } finally {
              store.close();
            }

            for (let writer = 0; writer < WRITER_COUNT; writer += 1) {
              const handle = spawn("writer", `writer-${writer}`, { writer, startSeq: 1 }, writer);
              writerHandle.set(writer, handle);
            }
            spawn("reader-long", "reader-long", {});
            spawn("reader-short", "reader-short", {});
            spawn("checkpointer", "checkpointer", {});
            spawn("snapshotter", "snapshotter", { snapshotDirectory });
            await Promise.all(handles.map((handle) => handle.waiter.waitFor("ready")));

            // Seeded chaos plan: kill times spread over the middle of the run, victims and jitter from the seed.
            const killCount = Math.max(3, Math.round(DURATION_SECONDS / 4));
            // The first kill is always in the first half so even the minimum run schedules (and consumes) at least one.
            const killPlan = Array.from({ length: killCount }, (_unused, index) => ({
              at: (0.1 + sharedRandom() * (index === 0 ? 0.4 : 0.8)) * DURATION_SECONDS * 1000,
              writer: Math.floor(sharedRandom() * WRITER_COUNT),
            }));
            loadStartedAt = Date.now();
            for (const planned of killPlan) setTimeout(() => !stopping && killPending.add(planned.writer), planned.at);
            for (let writer = 0; writer < WRITER_COUNT; writer += 1) dispatch(writer);

            await new Promise<void>((resolve) => {
              const tick = setInterval(() => {
                if (Date.now() - loadStartedAt >= DURATION_SECONDS * 1000 || fatals.length > 0) {
                  clearInterval(tick);
                  resolve();
                }
              }, 100);
            });
            stopping = true;
            loadSeconds = (Date.now() - loadStartedAt) / 1000;
            await Promise.all(killTasks);
            for (const handle of handles) {
              if (handle.waiter.child.exitCode === null && handle.waiter.child.signalCode === null) {
                handle.waiter.send({ type: "stop" });
              }
            }
            await Promise.all(handles.map((handle) => handle.closed));
            for (const handle of handles) {
              const state = handle.waiter.child.signalCode ? "killed" : "exited";
              if (state === "exited") expect(handle.finalReceived, `${handle.name} sent its final report`).toBe(true);
            }
            expect(fatals, "worker failures other than SQLITE_BUSY").toEqual([]);
            expect(
              handles.flatMap((handle) => handle.waiter.ipcErrors().map((error) => `${handle.name}: ${error}`)),
              "IPC errors to workers that were not killed on purpose",
            ).toEqual([]);
            expect(kills.length, "SIGKILL coverage: at least one writer was killed").toBeGreaterThan(0);
          })(),
        ]);

        // ---- Verification, every process is gone and every connection closed. ----
        const acked = [...highWater];
        const live = new DatabaseSync(sandbox.databasePath);
        let walBytes = -1;
        try {
          live.exec("PRAGMA busy_timeout = 5000");
          assertConsistent(live, "final database", { fts: true });
          // Writers are gone and every committed in-flight write was retried to its ack: rows are exactly the acked seqs.
          assertPrefixes(live, "final database", acked, acked);
          const checkpoint = live.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
          expect(checkpoint.busy, "final TRUNCATE checkpoint was not blocked").toBe(0);
        } finally {
          live.close();
        }
        const walPath = `${sandbox.databasePath}-wal`;
        walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
        expect(walBytes, "-wal file after the final TRUNCATE checkpoint with every connection closed").toBe(0);

        // ---- Snapshots: each is a consistent, gap-free prefix between its before and after marks. ----
        const complete = snapshots.filter((entry) => entry.path && entry.after).sort((a, b) => a.index - b.index);
        expect(complete.length, "at least one snapshot completed").toBeGreaterThan(0);
        for (const snapshot of complete) {
          const db = new DatabaseSync(snapshot.path, { readOnly: true });
          try {
            assertConsistent(db, `snapshot ${snapshot.index}`, { fts: false });
            assertPrefixes(db, `snapshot ${snapshot.index}`, snapshot.before, snapshot.after ?? []);
          } finally {
            db.close();
          }
        }

        // ---- Restore comparison: production restoreDatabase, then a row fingerprint against the snapshot's own. ----
        const toRestore = [
          ...new Set([complete[0], complete[Math.floor(complete.length / 2)], complete[complete.length - 1]]),
        ];
        const restored: Array<{ snapshot: number; tables: number; rows: number }> = [];
        for (const snapshot of toRestore) {
          if (!snapshot) continue;
          const target = join(sandbox.root, `restored-${snapshot.index}`, "work-intelligence.sqlite");
          mkdirSync(dirname(target), { recursive: true });
          const result = restoreDatabase({
            source: snapshot.path,
            databasePath: target,
            initializeStaging: (database) => initializeWorkIntelligenceDatabase(database, ":memory:"),
            backupDirectory: join(sandbox.root, `restored-${snapshot.index}`, "backups"),
          });
          const source = new DatabaseSync(snapshot.path, { readOnly: true });
          const copy = new DatabaseSync(target);
          try {
            const expected = fingerprintDatabase(source);
            const actual = fingerprintDatabase(copy);
            expect(Object.keys(expected).length, "fingerprinted tables").toBeGreaterThan(5);
            expect(
              actual,
              `restored snapshot ${snapshot.index} fingerprint (excluding ${RESTORE_EXCLUDED_TABLES.join(", ")})`,
            ).toEqual(expected);
            const revisions = (db: DatabaseSync): { database_id: string; data_revision: number } =>
              db.prepare("SELECT database_id, data_revision FROM change_revisions WHERE singleton = 1").get() as {
                database_id: string;
                data_revision: number;
              };
            // The excluded table must change exactly as restoreDatabase documents: new identity, revision bumped.
            expect(revisions(copy).database_id).not.toBe(revisions(source).database_id);
            expect(revisions(copy).data_revision).toBeGreaterThan(revisions(source).data_revision);
            assertConsistent(copy, `restored snapshot ${snapshot.index}`, { fts: true });
            expect(result.sessions).toBe(
              Object.values(readStressRows(source).bySeq).reduce((sum, seqs) => sum + seqs.size, 0),
            );
            restored.push({
              snapshot: snapshot.index,
              tables: Object.keys(actual).length,
              rows: Object.values(actual).reduce((sum, table) => sum + table.rows, 0),
            });
          } finally {
            source.close();
            copy.close();
          }
        }

        // ---- Report (measured numbers; BUSY is reported, never asserted). ----
        const sum = (role: Role, pick: (stats: Stats) => number): number =>
          handles.filter((handle) => handle.role === role).reduce((total, handle) => total + pick(handle.stats), 0);
        const writes = acked.reduce((total, seq) => total + seq, 0);
        const roleReport = (role: Role, ops: number) => ({
          processes: handles.filter((handle) => handle.role === role).length,
          ops,
          opsPerSecond: Number((ops / loadSeconds).toFixed(1)),
          busy: sum(role, (stats) => stats.busy),
          otherErrors: sum(role, (stats) => stats.otherErrors),
        });
        const report = {
          ticket: "DT-07",
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.versions.node,
          sqliteVersion,
          walResetFixed: !assessment.affected,
          walResetAssessment: assessment,
          seed: SEED,
          configuredDurationSeconds: DURATION_SECONDS,
          loadSeconds: Number(loadSeconds.toFixed(2)),
          roles: {
            writer: { ...roleReport("writer", writes), ackedPerWriter: acked },
            readerLong: {
              ...roleReport(
                "reader-long",
                sum("reader-long", (stats) => stats.ops),
              ),
              transactions: sum("reader-long", (stats) => stats.extra.transactions ?? 0),
            },
            readerShort: roleReport(
              "reader-short",
              sum("reader-short", (stats) => stats.ops),
            ),
            checkpointer: roleReport(
              "checkpointer",
              sum("checkpointer", (stats) => stats.ops),
            ),
            snapshotter: roleReport(
              "snapshotter",
              sum("snapshotter", (stats) => stats.ops),
            ),
          },
          checkpoints,
          snapshots: { count: complete.length, verified: complete.length, restoredAndCompared: restored },
          restoreFingerprintExcludedTables: [...RESTORE_EXCLUDED_TABLES],
          kills: {
            count: kills.length,
            inFlightCommitted: kills.filter((kill) => kill.inFlight === "committed").length,
            inFlightAbsent: kills.filter((kill) => kill.inFlight === "absent").length,
          },
          finalWalBytes: walBytes,
          note: "Busy counts of a SIGKILLed process cover only what it reported before dying (stats are sent once a second).",
          passed: true,
        };
        console.log(`[sqlite-stress] result ${JSON.stringify(report)}`);
        writeResult(report);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        clearTimeout(watchdog);
        stopping = true;
        await sandbox.stopAll();
        if (failure) {
          writeResult({
            ticket: "DT-07",
            platform: process.platform,
            sqliteVersion,
            walResetFixed: !assessment.affected,
            seed: SEED,
            configuredDurationSeconds: DURATION_SECONDS,
            passed: false,
            // Labels only: no raw worker stderr, stack traces or absolute paths (the console diagnostics keep full detail).
            failure: redactedFailure(failure),
            kills: kills.length,
            highWater,
          });
          dumpDiagnostics(`test failed: ${String((failure as Error)?.message ?? failure).slice(0, 300)}`);
        }
        removeTree(sandbox.root);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function writeResult(report: object): void {
  mkdirSync(dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, `${JSON.stringify(report, null, 2)}\n`);
}

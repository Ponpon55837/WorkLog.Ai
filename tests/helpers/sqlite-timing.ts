/** Test-only SQLite timing hook, active only with WI_SQLITE_TIMING=1. Never import it from production code: check-production-bundle.mjs fails on the "WI_SQLITE_TIMING" marker. */
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface SqliteTimingRecord {
  kind:
    "slow" | "begin-immediate" | "transaction" | "open" | "checkpoint" | "test-duration" | "begin-immediate-histogram";
  [key: string]: unknown;
}

export interface SqliteTimingOptions {
  directory?: string;
  label?: string;
}

export interface SqliteTimingSummary {
  line: string;
  file: string;
  opens: number;
  slowCalls: number;
  beginImmediate: number;
  checkpoints: number;
  slowTests: number;
}

type AnyFunction = (...args: unknown[]) => unknown;
type SqliteModule = typeof import("node:sqlite");

interface OpenInfo {
  openedAt: number;
  record: SqliteTimingRecord;
  db: string;
  transactionStart: number;
  transactionTest: string | null;
  /** Whether the open transaction took the write lock; in WAL mode a read transaction never blocks BEGIN IMMEDIATE. */
  transactionWrites: boolean;
}

interface TimingState {
  file: string;
  directory: string;
  label: string;
  records: SqliteTimingRecord[];
  histogram: number[];
  beginCount: number;
  beginMax: number;
  beginTotal: number;
  openCount: number;
  openMaxConstructorMs: number;
  openMaxGapMs: number;
  slowCount: number;
  slowMax: number;
  checkpointCount: number;
  checkpointBusy: number;
  checkpointMax: number;
  slowTests: number;
  histogramDirty: boolean;
  testNameProvider: () => string | undefined;
  testFileProvider: () => string | undefined;
  restore: () => void;
  timer: NodeJS.Timeout | undefined;
  summaryPrinted: boolean;
  esmHook: boolean;
}

const SLOW_CALL_MS = 1000;
const BEGIN_RECORD_MS = 100;
const SLOW_TEST_MS = 10_000;
const FLUSH_INTERVAL_MS = 5000;
const SQL_PREFIX_LENGTH = 120;
const BUCKET_LIMITS_MS = [1, 10, 100, 1000, 5000];
const BUCKET_NAMES = ["<1", "<10", "<100", "<1000", "<5000", ">=5000"];
const MAX_OPEN_RECORDS = 50_000;
const MAX_CHECKPOINT_RECORDS = 10_000;
const STATE_KEY = Symbol.for("work-intelligence.sqliteTiming");
const OPEN_KEY = Symbol("work-intelligence.sqliteTiming.open");
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BEGIN_IMMEDIATE_PATTERN = /^\s*begin\s+immediate\b/i;
const BEGIN_PATTERN = /^\s*begin\b/i;
const BEGIN_EXCLUSIVE_PATTERN = /^\s*begin\s+exclusive\b/i;
const WRITE_PATTERN =
  /(?:^|;)(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:insert|update|delete|replace|create|drop|alter|reindex|analyze)\b/i;
const CTE_WRITE_PATTERN =
  /(?:^|;)(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*with\b[\s\S]*?\)\s*(?:(?:insert|replace)\s+(?:or\s+[a-z]+\s+)?into\b|update\s+(?:or\s+[a-z]+\s+)?[\w"`[]|delete\s+from\b)/i;
/** SQLITE_BUSY and SQLITE_LOCKED: the statement did not get the lock, so it did not take the write lock either. */
const BUSY_CODES = new Set([5, 6]);
const TRANSACTION_END_PATTERN = /^\s*(commit|end|rollback)\b(?!\s+to\b)/i;
const CHECKPOINT_PATTERN = /wal_checkpoint/i;
const CHECKPOINT_MODE_PATTERN = /wal_checkpoint\s*\(\s*([a-z]+)/i;

type GlobalWithState = typeof globalThis & { [STATE_KEY]?: TimingState };

function getState(): TimingState | undefined {
  return (globalThis as GlobalWithState)[STATE_KEY];
}

function sqlPrefix(sql: unknown): string {
  return typeof sql === "string" ? sql.slice(0, SQL_PREFIX_LENGTH) : "";
}

export function isWriteSql(sql: unknown): boolean {
  return typeof sql === "string" && (WRITE_PATTERN.test(sql) || CTE_WRITE_PATTERN.test(sql));
}

export function isBusyError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof code === "number" && BUSY_CODES.has(code & 0xff);
}

function deferredReader(open: OpenInfo | undefined): OpenInfo | undefined {
  return open !== undefined && open.transactionStart !== 0 && !open.transactionWrites ? open : undefined;
}

/** A write that failed for a reason other than busy (a constraint, say) still took the lock, so it counts too. */
function noteWrite(open: OpenInfo, sql: unknown, changes: unknown, error: unknown): void {
  if (error !== undefined && isBusyError(error)) return;
  if ((typeof changes === "number" || typeof changes === "bigint") && changes > 0) open.transactionWrites = true;
  else if (isWriteSql(sql)) open.transactionWrites = true;
}

function stackOfCaller(): string {
  return (new Error().stack ?? "").split("\n").slice(4, 12).join("\n");
}

// Microsecond precision: a whole-millisecond `at` made two moments 0.2 ms apart look like they overlapped.
function wallClockAgo(agoMs: number): number {
  return Math.round((performance.timeOrigin + performance.now() - agoMs) * 1000) / 1000;
}

function baseRecord(state: TimingState, kind: SqliteTimingRecord["kind"], fields: Record<string, unknown>) {
  return {
    kind,
    ...fields,
    test: state.testNameProvider() ?? null,
    testFile: state.testFileProvider() ?? null,
    pid: process.pid,
    role: process.env.WI_STRESS_ROLE || "test",
  } as SqliteTimingRecord;
}

function bucketIndex(ms: number): number {
  let index = 0;
  while (index < BUCKET_LIMITS_MS.length && ms >= (BUCKET_LIMITS_MS[index] as number)) index += 1;
  return index;
}

function recordSlow(state: TimingState, op: string, sql: unknown, ms: number, failed: boolean, db?: string): void {
  state.slowCount += 1;
  if (ms > state.slowMax) state.slowMax = ms;
  state.records.push(
    baseRecord(state, "slow", {
      op,
      sql: sqlPrefix(sql),
      ms: Math.round(ms * 10) / 10,
      at: wallClockAgo(ms),
      db: db ?? null,
      failed,
      stack: stackOfCaller(),
    }),
  );
}

function recordBegin(state: TimingState, sql: unknown, ms: number, failed: boolean, db: string | null): void {
  state.beginCount += 1;
  state.beginTotal += ms;
  if (ms > state.beginMax) state.beginMax = ms;
  state.histogram[bucketIndex(ms)] = (state.histogram[bucketIndex(ms)] ?? 0) + 1;
  state.histogramDirty = true;
  if (ms >= BEGIN_RECORD_MS) {
    state.records.push(
      baseRecord(state, "begin-immediate", {
        op: "exec",
        sql: sqlPrefix(sql),
        ms: Math.round(ms * 10) / 10,
        at: wallClockAgo(ms),
        db,
        failed,
      }),
    );
  }
}

function recordCheckpoint(
  state: TimingState,
  sql: unknown,
  ms: number,
  row: unknown,
  failed: boolean,
  db: string | null,
): void {
  state.checkpointCount += 1;
  if (ms > state.checkpointMax) state.checkpointMax = ms;
  const values = (Array.isArray(row) ? row[0] : row) as
    { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
  const busy = values && typeof values === "object" ? Number(values.busy) : undefined;
  if (busy === 1) state.checkpointBusy += 1;
  if (state.checkpointCount > MAX_CHECKPOINT_RECORDS) return;
  const match = typeof sql === "string" ? CHECKPOINT_MODE_PATTERN.exec(sql) : null;
  state.records.push(
    baseRecord(state, "checkpoint", {
      mode: (match?.[1] ?? "PASSIVE").toUpperCase(),
      ms: Math.round(ms * 10) / 10,
      at: wallClockAgo(ms),
      db,
      failed,
      busy: busy ?? null,
      log: values && typeof values === "object" && values.log !== undefined ? Number(values.log) : null,
      checkpointed:
        values && typeof values === "object" && values.checkpointed !== undefined ? Number(values.checkpointed) : null,
    }),
  );
}

function recordTransaction(state: TimingState, open: OpenInfo, ms: number, sql: unknown): void {
  if (ms < BEGIN_RECORD_MS) return;
  state.records.push(
    baseRecord(state, "transaction", {
      op: "transaction",
      sql: sqlPrefix(sql),
      ms: Math.round(ms * 10) / 10,
      at: wallClockAgo(ms),
      db: open.db,
      write: open.transactionWrites,
      startTest: open.transactionTest,
    }),
  );
}

function markFirstStatement(open: OpenInfo, now: number): void {
  const gap = Math.round((now - open.openedAt) * 10) / 10;
  open.openedAt = 0;
  open.record.gapMs = gap;
  const state = getState();
  if (state && gap > state.openMaxGapMs) state.openMaxGapMs = gap;
}

function trackOpen(state: TimingState, db: object, path: unknown, options: unknown, ms: number, now: number): void {
  state.openCount += 1;
  if (ms > state.openMaxConstructorMs) state.openMaxConstructorMs = ms;
  if (state.openCount > MAX_OPEN_RECORDS) return;
  const location = typeof path === "string" ? path.replace(/\\/g, "/") : "";
  const record = baseRecord(state, "open", {
    file: location === ":memory:" ? location : location.slice(location.lastIndexOf("/") + 1),
    readOnly: Boolean((options as { readOnly?: unknown } | undefined)?.readOnly),
    constructorMs: Math.round(ms * 10) / 10,
    gapMs: null,
  });
  state.records.push(record);
  const segments = location.split("/").filter(Boolean);
  (db as { [OPEN_KEY]?: OpenInfo })[OPEN_KEY] = {
    openedAt: now,
    record,
    db: location === ":memory:" ? location : segments.slice(-2).join("/"),
    transactionStart: 0,
    transactionTest: null,
    transactionWrites: false,
  };
}

// 1 = BEGIN IMMEDIATE, 2 = wal_checkpoint pragma, 3 = COMMIT/END/ROLLBACK, 4 = another BEGIN, 0 = anything else.
function classifyExec(sql: unknown): number {
  if (typeof sql !== "string") return 0;
  const first = sql.charCodeAt(0);
  // B, b, P, p, C, c, E, e, R, r or leading whitespace; everything else cannot be one of the statements.
  if (first === 66 || first === 98) return BEGIN_IMMEDIATE_PATTERN.test(sql) ? 1 : BEGIN_PATTERN.test(sql) ? 4 : 0;
  if (first === 67 || first === 99 || first === 69 || first === 101 || first === 82 || first === 114) {
    return TRANSACTION_END_PATTERN.test(sql) ? 3 : 0;
  }
  if (first === 80 || first === 112 || first <= 32) {
    if (BEGIN_IMMEDIATE_PATTERN.test(sql)) return 1;
    if (BEGIN_PATTERN.test(sql)) return 4;
    if (TRANSACTION_END_PATTERN.test(sql)) return 3;
    return sql.length < 200 && CHECKPOINT_PATTERN.test(sql) ? 2 : 0;
  }
  return 0;
}

function writeRecords(state: TimingState, records: SqliteTimingRecord[]): void {
  if (records.length === 0) return;
  try {
    mkdirSync(state.directory, { recursive: true });
    appendFileSync(state.file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  } catch {
    // Evidence collection must never fail a test.
  }
}

function histogramRecord(state: TimingState): SqliteTimingRecord {
  const buckets: Record<string, number> = {};
  BUCKET_NAMES.forEach((name, index) => {
    buckets[name] = state.histogram[index] ?? 0;
  });
  return baseRecord(state, "begin-immediate-histogram", {
    cumulative: true,
    count: state.beginCount,
    totalMs: Math.round(state.beginTotal),
    maxMs: Math.round(state.beginMax * 10) / 10,
    buckets,
  });
}

export function flushSqliteTiming(): void {
  const state = getState();
  if (!state) return;
  const pending = state.records;
  state.records = [];
  if (state.histogramDirty) {
    state.histogramDirty = false;
    pending.push(histogramRecord(state));
  }
  writeRecords(state, pending);
}

export function sqliteTimingSummary(): SqliteTimingSummary | undefined {
  const state = getState();
  if (!state) return undefined;
  const buckets = BUCKET_NAMES.map((name, index) => `${name}:${state.histogram[index] ?? 0}`).join(" ");
  const line =
    `[sqlite timing] label=${state.label} pid=${process.pid} role=${process.env.WI_STRESS_ROLE || "test"} ` +
    `opens=${state.openCount} (max ctor ${state.openMaxConstructorMs.toFixed(1)} ms, max open->first statement ${state.openMaxGapMs.toFixed(1)} ms) ` +
    `calls>=1s=${state.slowCount} (max ${state.slowMax.toFixed(1)} ms) ` +
    `begin-immediate=${state.beginCount} [${buckets}] max ${state.beginMax.toFixed(1)} ms ` +
    `checkpoints=${state.checkpointCount} (busy=${state.checkpointBusy}, max ${state.checkpointMax.toFixed(1)} ms) ` +
    `tests>=10s=${state.slowTests} esmHook=${state.esmHook} file=${state.file}`;
  return {
    line,
    file: state.file,
    opens: state.openCount,
    slowCalls: state.slowCount,
    beginImmediate: state.beginCount,
    checkpoints: state.checkpointCount,
    slowTests: state.slowTests,
  };
}

export function recordTestDuration(name: string, durationMs: number): void {
  const state = getState();
  if (!state || durationMs < SLOW_TEST_MS) return;
  state.slowTests += 1;
  state.records.push(baseRecord(state, "test-duration", { name, ms: Math.round(durationMs), op: "test", sql: "" }));
}

export function setSqliteTimingTestNameProvider(
  provider: () => string | undefined,
  fileProvider: () => string | undefined = () => undefined,
): void {
  const state = getState();
  if (!state) return;
  state.testNameProvider = provider;
  state.testFileProvider = fileProvider;
}

export function isSqliteTimingInstalled(): boolean {
  return getState() !== undefined;
}

export function finishSqliteTiming(print: boolean): SqliteTimingSummary | undefined {
  flushSqliteTiming();
  const state = getState();
  const summary = sqliteTimingSummary();
  if (state && summary && print && !state.summaryPrinted) {
    state.summaryPrinted = true;
    try {
      writeSync(1, `${summary.line}\n`);
    } catch {
      // stdout may be closed; the JSONL file still has the data.
    }
  }
  return summary;
}

export function uninstallSqliteTiming(): void {
  const state = getState();
  if (!state) return;
  flushSqliteTiming();
  if (state.timer) clearInterval(state.timer);
  state.restore();
  delete (globalThis as GlobalWithState)[STATE_KEY];
}

const SHIM_SETTER_KEY = Symbol.for("work-intelligence.sqliteTiming.setDatabaseSync");

// Undefined when module.registerHooks does not exist (older Node lines); opens are then no longer timed.
function registerEsmHook(sqlite: SqliteModule, timed: unknown): { restore: (original: unknown) => void } | undefined {
  if (typeof registerHooks !== "function") return undefined;
  const names = Object.keys(sqlite).filter((name) => name !== "DatabaseSync" && name !== "default");
  const source = [
    'const real = process.getBuiltinModule("node:sqlite");',
    "export let DatabaseSync = real.DatabaseSync;",
    `globalThis[Symbol.for("work-intelligence.sqliteTiming.setDatabaseSync")] = (value) => { DatabaseSync = value; };`,
    ...names.map((name) => `export const ${name} = real[${JSON.stringify(name)}];`),
    `export default { ...real, get DatabaseSync() { return DatabaseSync; } };`,
  ].join("\n");
  const shimUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  // A shim evaluated by an earlier install keeps its live binding; point it at this install's subclass.
  (globalThis as { [SHIM_SETTER_KEY]?: (value: unknown) => void })[SHIM_SETTER_KEY]?.(timed);
  const handle = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:sqlite" && !context.conditions?.includes("require")) {
        return { url: shimUrl, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  return {
    restore(original) {
      handle.deregister();
      const setter = (globalThis as { [SHIM_SETTER_KEY]?: (value: unknown) => void })[SHIM_SETTER_KEY];
      setter?.(original);
    },
  };
}

export function installSqliteTiming(options: SqliteTimingOptions = {}): void {
  if (getState()) return;
  const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  const Original = sqlite.DatabaseSync;
  const databaseProto = Original.prototype as unknown as Record<string, AnyFunction>;
  // StatementSync is only exported by newer Node lines; the prototype of a throwaway statement always works.
  const probe = new Original(":memory:");
  const statementProto = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, AnyFunction>;
  probe.close();

  const directory = options.directory ?? (process.env.WI_SQLITE_TIMING_DIR || resolve(REPOSITORY_ROOT, "perf-results"));
  const label = options.label ?? (process.env.WI_SQLITE_TIMING_LABEL || "tests");
  const state: TimingState = {
    file: resolve(directory, `sqlite-timing-${label}-${process.pid}.jsonl`),
    directory,
    label,
    records: [],
    histogram: BUCKET_NAMES.map(() => 0),
    beginCount: 0,
    beginMax: 0,
    beginTotal: 0,
    openCount: 0,
    openMaxConstructorMs: 0,
    openMaxGapMs: 0,
    slowCount: 0,
    slowMax: 0,
    checkpointCount: 0,
    checkpointBusy: 0,
    checkpointMax: 0,
    slowTests: 0,
    histogramDirty: false,
    testNameProvider: () => undefined,
    testFileProvider: () => undefined,
    restore: () => undefined,
    timer: undefined,
    summaryPrinted: false,
    esmHook: false,
  };
  (globalThis as GlobalWithState)[STATE_KEY] = state;
  const now = (): number => performance.now();

  const originals: Array<[Record<string, AnyFunction>, string, AnyFunction]> = [];
  const patch = (target: Record<string, AnyFunction>, name: string, wrapper: AnyFunction): void => {
    originals.push([target, name, target[name] as AnyFunction]);
    target[name] = wrapper;
  };

  const originalExec = databaseProto.exec as AnyFunction;
  const originalPrepare = databaseProto.prepare as AnyFunction;

  const statementOpen = new WeakMap<object, OpenInfo>();

  const watchCheckpointStatement = (statement: Record<string, AnyFunction>, sql: string, db: string | null): void => {
    for (const method of ["get", "all", "run"] as const) {
      const inner = statement[method] as AnyFunction;
      statement[method] = function (this: unknown) {
        const start = now();
        let failed = true;
        let result: unknown;
        try {
          result = Reflect.apply(inner, this, arguments as unknown as unknown[]);
          failed = false;
          return result;
        } finally {
          recordCheckpoint(state, sql, now() - start, result, failed, db);
        }
      };
    }
  };

  patch(databaseProto, "exec", function (this: { [OPEN_KEY]?: OpenInfo }, sql: unknown) {
    const open = this[OPEN_KEY];
    const kind = classifyExec(sql);
    const start = now();
    if (open !== undefined && open.openedAt !== 0) markFirstStatement(open, start);
    let failed = true;
    let error: unknown;
    try {
      const result = Reflect.apply(originalExec, this, arguments as unknown as unknown[]);
      failed = false;
      return result;
    } catch (caught) {
      error = caught ?? null;
      throw caught;
    } finally {
      const end = now();
      const ms = end - start;
      if (kind === 1 || kind === 4) {
        if (kind === 1) recordBegin(state, sql, ms, failed, open?.db ?? null);
        if (open !== undefined && !failed) {
          open.transactionStart = end;
          open.transactionTest = state.testNameProvider() ?? null;
          open.transactionWrites = kind === 1 || BEGIN_EXCLUSIVE_PATTERN.test(sql as string);
        }
      } else if (kind === 2) recordCheckpoint(state, sql, ms, undefined, failed, open?.db ?? null);
      else if (kind === 3 && open !== undefined && open.transactionStart !== 0) {
        recordTransaction(state, open, end - open.transactionStart, sql);
        open.transactionStart = 0;
      } else if (kind === 0) {
        const reader = deferredReader(open);
        if (reader !== undefined) noteWrite(reader, sql, undefined, error);
      }
      if (ms >= SLOW_CALL_MS) recordSlow(state, "exec", sql, ms, failed, open?.db);
    }
  });

  patch(databaseProto, "prepare", function (this: { [OPEN_KEY]?: OpenInfo }, sql: unknown) {
    const start = now();
    const open = this[OPEN_KEY];
    if (open !== undefined && open.openedAt !== 0) markFirstStatement(open, start);
    let failed = true;
    let statement: Record<string, AnyFunction> | undefined;
    try {
      statement = Reflect.apply(originalPrepare, this, arguments as unknown as unknown[]) as Record<
        string,
        AnyFunction
      >;
      failed = false;
      return statement;
    } finally {
      const ms = now() - start;
      if (ms >= SLOW_CALL_MS) recordSlow(state, "prepare", sql, ms, failed);
      if (statement !== undefined && open !== undefined) statementOpen.set(statement, open);
      if (statement !== undefined && typeof sql === "string" && sql.length < 200 && CHECKPOINT_PATTERN.test(sql)) {
        watchCheckpointStatement(statement, sql, open?.db ?? null);
      }
    }
  });

  for (const method of ["run", "get", "all"] as const) {
    const original = statementProto[method] as AnyFunction;
    patch(statementProto, method, function (this: { sourceSQL?: string }) {
      const start = now();
      let failed = true;
      let result: unknown;
      let error: unknown;
      try {
        result = Reflect.apply(original, this, arguments as unknown as unknown[]);
        failed = false;
        return result;
      } catch (caught) {
        error = caught ?? null;
        throw caught;
      } finally {
        const ms = now() - start;
        // sourceSQL is a getter that allocates; it is read only inside a deferred transaction that has not written yet.
        const reader = deferredReader(statementOpen.get(this));
        if (reader !== undefined) {
          const changes = method === "run" ? (result as { changes?: unknown } | undefined)?.changes : undefined;
          noteWrite(reader, this.sourceSQL, changes, error);
        }
        if (ms >= SLOW_CALL_MS) recordSlow(state, method, this.sourceSQL, ms, failed);
      }
    });
  }

  const originalIterate = statementProto.iterate as AnyFunction;
  patch(statementProto, "iterate", function (this: { sourceSQL?: string }) {
    const start = now();
    const iterator = Reflect.apply(originalIterate, this, arguments as unknown as unknown[]) as {
      next: AnyFunction;
    };
    const originalNext = iterator.next;
    const statement = this;
    iterator.next = function (this: unknown) {
      iterator.next = originalNext;
      const stepStart = now();
      let failed = true;
      let error: unknown;
      try {
        const result = Reflect.apply(originalNext, this, arguments as unknown as unknown[]);
        failed = false;
        return result;
      } catch (caught) {
        error = caught ?? null;
        throw caught;
      } finally {
        const ms = now() - stepStart + (stepStart - start);
        const reader = deferredReader(statementOpen.get(statement));
        if (reader !== undefined) noteWrite(reader, statement.sourceSQL, undefined, error);
        if (ms >= SLOW_CALL_MS) recordSlow(state, "iterate", statement.sourceSQL, ms, failed);
      }
    };
    return iterator;
  });

  class TimedDatabaseSync extends Original {
    public constructor(...args: ConstructorParameters<typeof Original>) {
      const start = now();
      super(...args);
      const end = now();
      trackOpen(state, this, args[0], args[1], end - start, end);
      if (end - start >= SLOW_CALL_MS) recordSlow(state, "open", String(args[0]).slice(-60), end - start, false);
    }
  }
  const originalExport = sqlite.DatabaseSync;
  // module.syncBuiltinESMExports() does not cover node:sqlite (it only syncs builtins requirable without the "node:" scheme), so a resolve hook points ESM imports at a shim that re-exports the builtin with the subclass.
  (sqlite as { DatabaseSync: unknown }).DatabaseSync = TimedDatabaseSync;
  const hook = registerEsmHook(sqlite, TimedDatabaseSync);
  state.restore = (): void => {
    for (const [target, name, original] of originals.reverse()) target[name] = original;
    (sqlite as { DatabaseSync: unknown }).DatabaseSync = originalExport;
    hook?.restore(originalExport);
  };
  state.esmHook = hook !== undefined;

  state.timer = setInterval(flushSqliteTiming, FLUSH_INTERVAL_MS);
  state.timer.unref();
  process.on("exit", () => {
    if (getState() !== state) return;
    finishSqliteTiming(Boolean(process.env.WI_STRESS_ROLE) || !process.env.VITEST_WORKER_ID);
  });
}

if (process.env.WI_SQLITE_TIMING === "1") installSqliteTiming();

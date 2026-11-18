import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushSqliteTiming,
  installSqliteTiming,
  isSqliteTimingInstalled,
  uninstallSqliteTiming,
} from "../helpers/sqlite-timing.js";
import { sqliteTimingReport } from "../helpers/sqlite-timing-report.mjs";

const require = createRequire(import.meta.url);
const CHILD_SCRIPT = join(import.meta.dirname, "..", "helpers", "sqlite-timing-child.ts");
const LOCK_HOLD_MS = 1200;
const directories: string[] = [];

interface ChildRun {
  className: string;
  directory: string;
}

async function nativeImport(): Promise<{ DatabaseSync: typeof DatabaseSync }> {
  // A module required from a temp .mjs file is loaded by Node's own loader (not vite-node) and so is its import().
  const loader = join(createDirectory(), "native-import.mjs");
  writeFileSync(loader, "export const load = (specifier) => import(specifier);\n");
  const { load } = require(loader) as { load: (specifier: string) => Promise<unknown> };
  return (await load("node:sqlite")) as { DatabaseSync: typeof DatabaseSync };
}

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-sqlite-timing-"));
  directories.push(directory);
  return directory;
}

function readRecords(directory: string): Array<Record<string, unknown>> {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(directory, name), "utf8").trim().split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Runs the child while this process holds the write lock for LOCK_HOLD_MS, so the child's BEGIN IMMEDIATE waits. */
async function runChildBehindLock(timingEnabled: boolean): Promise<ChildRun> {
  const directory = createDirectory();
  const databasePath = join(directory, "timing.sqlite");
  const holder = new DatabaseSync(databasePath);
  holder.exec("PRAGMA journal_mode = WAL");
  holder.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  holder.exec("BEGIN IMMEDIATE");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    WI_SQLITE_TIMING: timingEnabled ? "1" : "",
    WI_SQLITE_TIMING_DIR: directory,
  };
  delete environment.WI_STRESS_ROLE;
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(require.resolve("tsx/esm")).href, CHILD_SCRIPT, databasePath],
    { env: environment, stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  const ready = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready")) resolve();
    });
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  await ready;
  await new Promise((resolve) => setTimeout(resolve, LOCK_HOLD_MS));
  holder.exec("COMMIT");
  expect(await exited).toBe(0);
  holder.close();
  const line = output.split("\n").find((entry) => entry.startsWith("{"));
  return { className: (JSON.parse(line ?? "{}") as { className?: string }).className ?? "", directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The name of node:sqlite's own class. Node 26 renamed it (`DatabaseSync` is an alias of `Database`), so compare with
 * the builtin's name instead of a literal; with the hook already installed, the builtin is the timed class's parent.
 */
function builtinClassName(): string {
  return DatabaseSync.name === "TimedDatabaseSync"
    ? (Object.getPrototypeOf(DatabaseSync) as { name: string }).name
    : DatabaseSync.name;
}

describe("sqlite timing hook", () => {
  it("records the slow BEGIN IMMEDIATE, the slow call, the open and the checkpoint when enabled", async () => {
    const { className, directory } = await runChildBehindLock(true);
    expect(className).toBe("TimedDatabaseSync");
    const records = readRecords(directory);

    const begin = records.find((record) => record.kind === "begin-immediate");
    expect(begin).toMatchObject({ op: "exec", sql: "BEGIN IMMEDIATE", role: "test", failed: false });
    expect(begin?.ms as number).toBeGreaterThanOrEqual(LOCK_HOLD_MS * 0.7);
    const slow = records.find((record) => record.kind === "slow");
    expect(slow).toMatchObject({ op: "exec", sql: "BEGIN IMMEDIATE" });
    expect(slow?.ms as number).toBeGreaterThanOrEqual(1000);
    expect(typeof slow?.stack).toBe("string");
    const histogram = records.find((record) => record.kind === "begin-immediate-histogram");
    expect(histogram).toMatchObject({ count: 1 });
    expect((histogram?.buckets as Record<string, number>)["<5000"]).toBe(1);
    expect(records.find((record) => record.kind === "open")).toMatchObject({ file: "timing.sqlite", readOnly: false });
    expect(records.filter((record) => record.kind === "open")[0]?.gapMs).toEqual(expect.any(Number));
    expect(records.find((record) => record.kind === "checkpoint")).toMatchObject({
      mode: "PASSIVE",
      busy: 0,
      log: expect.any(Number),
      checkpointed: expect.any(Number),
    });
    expect(JSON.stringify(records)).not.toContain("secret-parameter-value");

    // Wall-clock start and the database's last two path segments line records up across processes.
    const databaseLabel = `${basename(directory)}/timing.sqlite`;
    expect(begin).toMatchObject({ db: databaseLabel, at: expect.any(Number) });
    expect(Math.abs((begin?.at as number) - Date.now())).toBeLessThan(60_000);
    const transactions = records.filter((record) => record.kind === "transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ op: "transaction", sql: "COMMIT", db: databaseLabel });
    expect(transactions[0]?.ms as number).toBeGreaterThanOrEqual(140);

    // The report names the wait; its holder (this test process) is not instrumented, so it says so.
    const report = sqliteTimingReport(records).join("\n");
    expect(report).toContain("BEGIN IMMEDIATE waits (>= 1 s): 1");
    expect(report).toContain(`db=${databaseLabel}`);
    expect(report).toContain("holder: not inferred");
  }, 30_000);

  it("reports the ten slowest calls and the overlapping transactions on the same file as likely holders", () => {
    const at = 1_000_000;
    const slowCalls = Array.from({ length: 12 }, (_unused, index) => ({
      kind: "slow",
      op: "run",
      sql: `UPDATE t${index} SET a = ?`.padEnd(200, " x"),
      ms: 1000 + index,
      at,
      db: "a/db.sqlite",
      test: `test ${index}`,
      testFile: "tests/storage/x.test.ts",
      role: "test",
      pid: 1,
    }));
    const wait = { kind: "begin-immediate", ms: 2500, at, db: "a/db.sqlite", failed: false, pid: 2, role: "test" };
    const holder = {
      kind: "transaction",
      ms: 3000,
      at: at - 600,
      db: "a/db.sqlite",
      pid: 3,
      role: "writer",
      startTest: "w",
    };
    const otherFile = { kind: "transaction", ms: 3000, at: at - 600, db: "b/db.sqlite", pid: 4, role: "test" };
    const lines = sqliteTimingReport([...slowCalls, wait, holder, otherFile]);
    expect(lines[0]).toBe("[sqlite timing report] slow calls (>= 1 s): 12; top 10:");
    expect(lines.slice(1, 11).map((line) => line.trim().split(" ")[0])).toEqual(
      Array.from({ length: 10 }, (_unused, index) => String(1011 - index)),
    );
    expect(lines[1]).toContain('test="test 11"');
    expect(lines[1]).toContain("file=tests/storage/x.test.ts");
    expect(lines[1]?.match(/sql="([^"]*)"/)?.[1]).toHaveLength(120);
    expect(lines).toContain("[sqlite timing report] BEGIN IMMEDIATE waits (>= 1 s): 1");
    const holderLines = lines.filter((line) => line.includes("holder?"));
    expect(holderLines).toHaveLength(1);
    expect(holderLines[0]).toContain("pid=3");
    expect(holderLines[0]).toContain("overlapping 2400 ms");
  });

  it("writes nothing and leaves DatabaseSync untouched when the variable is empty", async () => {
    const { className, directory } = await runChildBehindLock(false);
    expect(className).toBe(builtinClassName());
    expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  }, 30_000);

  it("replaces the DatabaseSync that storage code imports through ESM bindings under vitest", async () => {
    const directory = createDirectory();
    if (isSqliteTimingInstalled()) {
      // The whole run has WI_SQLITE_TIMING=1: the setup file installed the hook before this file's imports.
      expect(DatabaseSync.name).toBe("TimedDatabaseSync");
      return;
    }
    expect(DatabaseSync.name).toBe(builtinClassName());
    installSqliteTiming({ directory, label: "unit" });
    let timedClass: unknown;
    try {
      // Vitest caches its own imports of the builtin, so ask Node's loader directly: this resolves node:sqlite through the
      // hook exactly like a freshly loaded storage module does.
      const imported = await nativeImport();
      timedClass = imported.DatabaseSync;
      expect(imported.DatabaseSync.name).toBe("TimedDatabaseSync");
      const db = new imported.DatabaseSync(":memory:");
      db.exec("CREATE TABLE t (x)");
      expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
      db.close();
      flushSqliteTiming();
      expect(readRecords(directory).find((record) => record.kind === "open")).toMatchObject({ file: ":memory:" });
    } finally {
      uninstallSqliteTiming();
    }
    const restored = await nativeImport();
    expect(restored.DatabaseSync).not.toBe(timedClass);
    expect(restored.DatabaseSync.name).toBe(builtinClassName());
  });
});

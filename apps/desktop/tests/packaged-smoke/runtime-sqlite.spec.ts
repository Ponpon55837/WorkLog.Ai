import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessSqliteWalResetFix } from "@work-intelligence/shared/sqlite-version";
import {
  createSandbox,
  removeSandbox,
  startApp,
  stopApp,
  waitForManaged,
  type PackagedSandbox,
  type RunningApp,
} from "./helpers.js";

/**
 * R33 / DT-06 in the packaged App: the SQLite of the Node runtime the App really runs its backend with. The App installs
 * its runtime under `<userData>/runtime`; that copy's own launcher prints `sqlite_version()` and FTS5 (the same code the
 * Agents' launcher uses). The result goes to package-results/ (uploaded with the package results) and the log; it holds
 * versions only, no paths and no user data.
 */

const resultsDirectory = join(import.meta.dirname, "..", "..", "package-results");

let sandbox: PackagedSandbox | undefined;
let app: RunningApp | undefined;

test.afterEach(async () => {
  if (sandbox) await stopApp(sandbox, app);
  app = undefined;
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
});

interface RuntimeInfo {
  nodeVersion?: string;
  runtimeKind?: string;
  sqlite?: { version?: string; fts5?: boolean; error?: string };
}

test("the runtime the packaged App installs bundles a patched SQLite with FTS5", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = startApp(sandbox);
  await waitForManaged(sandbox);

  const root = join(sandbox.userData, "runtime");
  const runtimeId = readFileSync(join(root, "current"), "utf8").trim();
  const runtimeDirectory = join(root, "runtimes", runtimeId);
  const executable = readFileSync(join(runtimeDirectory, "runtime-launch.txt"), "utf8").trim();
  const output = execFileSync(
    join(runtimeDirectory, ...executable.split("/")),
    [join(runtimeDirectory, "launcher.mjs"), "--print-runtime-info"],
    { encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  const info = JSON.parse(output) as RuntimeInfo;

  expect(info.runtimeKind).toBe("node");
  expect(info.sqlite?.error, "the runtime could not open node:sqlite").toBeUndefined();
  const sqliteVersion = info.sqlite?.version ?? "";
  const assessment = assessSqliteWalResetFix(sqliteVersion);
  const record = {
    runtimeNodeVersion: info.nodeVersion ?? "",
    sqliteVersion,
    walResetFixed: !assessment.affected,
    fts5: info.sqlite?.fts5 === true,
  };
  console.log(`[packaged-runtime] ${JSON.stringify(record)}`);
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(
    join(resultsDirectory, `package-runtime-sqlite-${process.platform}-${process.arch}.json`),
    `${JSON.stringify({ platform: process.platform, arch: process.arch, ...record }, null, 2)}\n`,
  );

  expect(record.runtimeNodeVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(assessment.recognized, `unrecognized sqlite_version() ${sqliteVersion}`).toBe(true);
  expect(assessment.affected, `SQLite ${sqliteVersion} has the WAL-reset bug (fix: ${assessment.fixedIn})`).toBe(false);
  expect(record.fts5).toBe(true);
});

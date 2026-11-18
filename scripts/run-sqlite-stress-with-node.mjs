#!/usr/bin/env node
/**
 * Runs the DT-07 SQLite stress suite (tests/stress/) with a given Node binary: `--node <path>` or WI_SQLITE_STRESS_NODE.
 * The whole suite runs under that binary (vitest, the orchestrator and, through `process.execPath`, every worker), so the
 * SQLite under test is the one that binary bundles, and the suite's own report records its Node and SQLite versions. Used
 * by the packaged smoke (apps/desktop/scripts/run-packaged-smoke.mjs) with the Node binary the packaged App ships.
 *
 *   --node <path>     the Node binary (default: WI_SQLITE_STRESS_NODE; required one way or the other)
 *   --copy-to <path>  copy the suite's JSON report there afterwards (the CI artifact); it holds no paths or user data
 * Duration and seed come from WI_SQLITE_STRESS_SECONDS and WI_SQLITE_STRESS_SEED, as for `pnpm test:sqlite-stress`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { node: { type: "string" }, "copy-to": { type: "string" } },
});
const nodeBinary = values.node ?? process.env.WI_SQLITE_STRESS_NODE;
if (!nodeBinary) {
  process.stderr.write("run-sqlite-stress-with-node: pass --node <path> or set WI_SQLITE_STRESS_NODE\n");
  process.exit(2);
}

const vitestCli = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const reportFile = join(repositoryRoot, "perf-results", `sqlite-stress-${process.platform}.json`);
// A stale report from an earlier run must never be mistaken for this run's.
rmSync(reportFile, { force: true });

const started = Date.now();
const result = spawnSync(
  nodeBinary,
  [
    vitestCli,
    "run",
    "--root",
    ".",
    "--config",
    join("tests", "stress", "vitest.config.ts"),
    "--disableConsoleIntercept",
  ],
  { cwd: repositoryRoot, stdio: "inherit", env: process.env },
);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (result.error) {
  process.stderr.write(`run-sqlite-stress-with-node: ${result.error.message}\n`);
  process.exit(1);
}
process.stdout.write(`[sqlite-stress] total wall time with the packaged runtime Node: ${seconds}s\n`);
if (Number(seconds) > 30) {
  process.stdout.write(
    `[sqlite-stress] WARNING: total wall time ${seconds}s exceeds the expected 30s (not a failure)\n`,
  );
}
let status = result.status ?? 1;
if (values["copy-to"]) {
  if (existsSync(reportFile)) {
    mkdirSync(dirname(resolve(values["copy-to"])), { recursive: true });
    copyFileSync(reportFile, resolve(values["copy-to"]));
  } else {
    process.stderr.write("run-sqlite-stress-with-node: --copy-to was given but the suite wrote no report file\n");
    status = status === 0 ? 1 : status;
  }
}
process.exit(status);

#!/usr/bin/env node
/**
 * The `work-intelligence` command of the standalone package (copied to `bin/` by scripts/build-standalone.mjs).
 * It only checks the Node.js version and hands over to the bundled CLI in this process: no child process, so signals
 * and stdio behave as they do for `node apps/.../index.js`, including on Windows.
 */
import { readFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

/** The package's engines.node, or undefined when it cannot be read. */
function requiredNodeRange() {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const range = JSON.parse(readFileSync(packagePath, "utf8")).engines?.node;
    return typeof range === "string" && range.trim() ? range.trim() : undefined;
  } catch {
    return undefined;
  }
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * True when `version` satisfies a range made of `||`-separated sets of `>=x.y.z` / `<x[.y[.z]]` comparators (the form
 * packages/shared's SUPPORTED_NODE_RANGE uses). A range in any other form is treated as satisfied rather than blocking.
 */
function satisfiesRange(range, version) {
  const actual = version.split(".").map(Number);
  const sets = range.split("||").map((set) => set.trim().split(/\s+/));
  let understood = true;
  const matches = sets.map((comparators) =>
    comparators.every((comparator) => {
      const match = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
      if (!match) {
        understood = false;
        return false;
      }
      const bound = [match[2], match[3] ?? 0, match[4] ?? 0].map(Number);
      return match[1] === ">=" ? compareVersions(actual, bound) >= 0 : compareVersions(actual, bound) < 0;
    }),
  );
  return !understood || matches.some(Boolean);
}

const requiredRange = requiredNodeRange();
if (requiredRange && !satisfiesRange(requiredRange, process.versions.node)) {
  console.error(`Work Intelligence 需要 Node.js ${requiredRange}（目前是 ${process.versions.node}）。`);
  process.exit(1);
}

const { runStandaloneCli } = await import(
  new URL("../libexec/apps/server/dist/standalone-cli.js", import.meta.url).href
);
const exitCode = await runStandaloneCli(process.argv.slice(2));
// start and mcp keep the process alive and may already have set a failure code; only add a failure, never clear one.
if (exitCode !== 0) process.exitCode = exitCode;

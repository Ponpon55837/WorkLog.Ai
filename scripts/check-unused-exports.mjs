#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unused-export guard. knip (see knip.json) lists the exports and types that nothing reachable from an entry point imports:
 * the apps' entry points, the scripts and each package's `index.ts` are the entries, and tests are not (a test that is the only
 * user of a helper does not make it used). The list at the time the guard was added is `knip-baseline.json`; from then on a
 * new unused export fails the check. Fix it by removing the export, or, for a helper that only tests use, by tagging it
 * `@internal test-only` in its comment (knip skips tagged exports). Never add a new entry to the baseline by hand: the
 * baseline only shrinks. `--update` rewrites it, and is for deleting entries after their exports were cleaned up.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "knip-baseline.json");
const update = process.argv.includes("--update");

const run = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["knip", "--include", "exports,types", "--reporter", "json", "--no-progress"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" },
);
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error("knip did not produce a report:\n" + (run.stderr || run.stdout).slice(0, 2000));
  process.exit(2);
}

/** `file#name`: no line number, so moving code inside a file does not change the key. */
const found = new Set();
for (const issue of report.issues ?? []) {
  for (const kind of ["exports", "types"]) {
    for (const entry of issue[kind] ?? []) found.add(`${issue.file}#${entry.name}`);
  }
}

if (update) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const kept = baseline.filter((key) => found.has(key));
  const added = [...found].filter((key) => !baseline.includes(key));
  if (added.length > 0 && process.argv.includes("--init") === false) {
    console.error(`Refusing to add ${added.length} new entries to the baseline:\n${added.sort().join("\n")}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, `${JSON.stringify([...kept, ...added].sort(), null, 2)}\n`);
  console.log(`Baseline now has ${kept.length + added.length} entries.`);
  process.exit(0);
}

const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")));
const fresh = [...found].filter((key) => !baseline.has(key)).sort();
const gone = [...baseline].filter((key) => !found.has(key)).sort();
if (gone.length > 0) {
  console.log(
    `${gone.length} baseline entries are no longer unused; run \`node scripts/check-unused-exports.mjs --update\` to drop them.`,
  );
}
if (fresh.length > 0) {
  console.error(
    `${fresh.length} new unused export(s):\n${fresh.map((key) => `  ${key.replace("#", "  ")}`).join("\n")}\n\n` +
      "Remove the export, or tag a helper that only tests use with `@internal test-only` in its comment.",
  );
  process.exit(1);
}
console.log(`No new unused exports (${baseline.size} older ones are in knip-baseline.json).`);

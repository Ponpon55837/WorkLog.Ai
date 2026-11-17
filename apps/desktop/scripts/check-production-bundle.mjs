#!/usr/bin/env node
/**
 * Fails when a production build still contains anything only a test build may have: the test environment variables, the
 * test hook's global, or the build flag itself (a leftover `__WI_TEST_BUILD__` means a `define` did not apply).
 *
 *   node scripts/check-production-bundle.mjs [distDirectory]     (default: ../dist next to this script's package)
 *
 * Exit code 0 when clean, 1 when a forbidden string is found (each hit is printed), 2 when there is nothing to check.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORBIDDEN = [
  "WORK_INTELLIGENCE_DESKTOP_",
  "WORK_INTELLIGENCE_SMOKE_",
  "__workIntelligenceDesktopTest",
  "__WI_TEST_BUILD__",
];
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".html", ".css", ".map", ".json"]);

function filesBelow(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const target = join(directory, name);
    if (statSync(target).isDirectory()) found.push(...filesBelow(target));
    else found.push(target);
  }
  return found;
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? join(here, "..", "dist");
let files;
try {
  files = filesBelow(dist).filter((file) => SCANNED_EXTENSIONS.has(file.slice(file.lastIndexOf("."))));
} catch {
  process.stderr.write(`check-production-bundle: cannot read ${dist}\n`);
  process.exit(2);
}
if (!files.some((file) => file.endsWith(join("main", "index.mjs")))) {
  process.stderr.write(`check-production-bundle: ${dist} has no main/index.mjs; build with --production first\n`);
  process.exit(2);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) if (text.includes(needle)) hits.push(`${relative(dist, file)}: ${needle}`);
}
if (hits.length > 0) {
  process.stderr.write(
    `check-production-bundle: test-only strings found in the production bundle:\n  ${hits.join("\n  ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`check-production-bundle: ${files.length} files clean\n`);

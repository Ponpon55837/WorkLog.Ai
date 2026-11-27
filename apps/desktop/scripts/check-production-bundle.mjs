#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORBIDDEN = [
  "WORK_INTELLIGENCE_DESKTOP_",
  "WORK_INTELLIGENCE_SMOKE_",
  "WORK_INTELLIGENCE_TEST_",
  "__workIntelligenceDesktopTest",
  "__WI_TEST_BUILD__",
  "__WI_DESKTOP_TEST_BUILD__",
  "WI_SQLITE_TIMING",
  "work-intelligence.sqliteTiming",
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
const runtimeMode = process.argv[2] === "--runtime";
const dist = runtimeMode ? process.argv[3] : (process.argv[2] ?? join(here, "..", "dist"));
if (dist === undefined) {
  process.stderr.write("check-production-bundle: --runtime needs a directory\n");
  process.exit(2);
}
let files;
try {
  files = filesBelow(dist).filter((file) => SCANNED_EXTENSIONS.has(file.slice(file.lastIndexOf("."))));
} catch {
  process.stderr.write(`check-production-bundle: cannot read ${dist}\n`);
  process.exit(2);
}
if (runtimeMode ? files.length === 0 : !files.some((file) => file.endsWith(join("main", "index.mjs")))) {
  process.stderr.write(
    runtimeMode
      ? `check-production-bundle: ${dist} has no files to scan\n`
      : `check-production-bundle: ${dist} has no main/index.mjs; build with --production first\n`,
  );
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

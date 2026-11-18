#!/usr/bin/env node
/**
 * Keeps the pnpm audit exceptions (`auditConfig.ignoreGhsas` in pnpm-workspace.yaml) from growing or going stale.
 *
 * It fails when:
 * - the ignore list differs from ALLOWED_AUDIT_IGNORES below (an entry was added or removed without updating this file);
 * - an ignored advisory is no longer reported by `pnpm audit --prod` (run on a temporary copy without the ignore list);
 * - the lockfile no longer resolves any vulnerable version of the advisory's package (a patched release is installed).
 *
 * With --registry (the daily .github/workflows/audit-exceptions-watch.yml), it also fails when the npm registry already
 * publishes a stable version of the advisory's package above its vulnerable range, i.e. a patched release exists.
 *
 * Usage: node scripts/check-audit-ignores.mjs [--offline | --registry]
 *   --offline   skips the `pnpm audit` call (list and lockfile checks only); the unit test covers the pure functions.
 *   --registry  adds the registry check (`npm view <package> versions --json`) to the full check.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Every allowed exception. `vulnerableUpTo` is the highest affected version (the advisory's range is `<= vulnerableUpTo`).
 * See docs/security/audit-exceptions.md for the reasoning and the removal condition of each entry.
 */
// Empty since 1.6.53: GHSA-fc5q-39xc-vjpf (picomatch) was resolved by moving vue-router back to 4.6.5, which drops
// picomatch from the production tree. Add an entry here only together with auditConfig.ignoreGhsas and the docs.
export const ALLOWED_AUDIT_IGNORES = Object.freeze({});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The GHSA ids under `auditConfig.ignoreGhsas` in a pnpm-workspace.yaml text (block list form). */
export function parseIgnoreGhsas(workspaceYaml) {
  const lines = workspaceYaml.split(/\r?\n/);
  const ids = [];
  let inAudit = false;
  let inList = false;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith("#")) {
      inAudit = /^auditConfig:\s*$/.test(line);
      inList = false;
      continue;
    }
    if (!inAudit) continue;
    if (/^ {2}ignoreGhsas:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (/^ {2}\S/.test(line) && !/^ {2}#/.test(line)) inList = false;
    const item = inList ? /^\s+-\s+["']?(GHSA-[0-9a-z-]+)["']?\s*(#.*)?$/i.exec(line) : null;
    if (item) ids.push(item[1]);
    else if (inList && /^\s+-/.test(line)) throw new Error(`Unrecognised ignoreGhsas entry: ${line.trim()}`);
  }
  return ids;
}

/** The text of pnpm-workspace.yaml with the whole `auditConfig` block removed. */
export function withoutAuditConfig(workspaceYaml) {
  const out = [];
  let skipping = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^\S/.test(line) && !line.startsWith("#")) skipping = /^auditConfig:\s*$/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** Every version of `name` that the pnpm lockfile resolves (keys like `  name@1.2.3:` or `  name@1.2.3(peer):`). */
export function lockfileVersions(lockfileText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@(\\d+\\.\\d+\\.\\d+[^:('\\s]*)`, "gm");
  return [...new Set([...lockfileText.matchAll(pattern)].map((match) => match[1]))].sort();
}

/** -1, 0 or 1 comparing two x.y.z versions (pre-release suffixes count as lower than the release). */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre] = value.split("-", 2);
    return { parts: core.split(".").map(Number), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return 0;
}

/**
 * The problems for an ignore list, the lockfile text and (unless null) the GHSA ids `pnpm audit` reports without the
 * ignore list. An empty array means the exceptions are exactly the allowed ones and each is still needed.
 */
export function auditIgnoreProblems({ ignored, lockfileText, reportedGhsas, allowed = ALLOWED_AUDIT_IGNORES }) {
  const problems = [];
  const allowedIds = Object.keys(allowed).sort();
  const actual = [...ignored].sort();
  if (actual.length !== new Set(actual).size) problems.push(`ignoreGhsas has duplicate entries: ${actual.join(", ")}`);
  for (const id of actual) {
    if (!allowed[id]) {
      problems.push(`${id} is ignored in pnpm-workspace.yaml but not allowed in scripts/check-audit-ignores.mjs`);
    }
  }
  for (const id of allowedIds) {
    if (!actual.includes(id)) {
      problems.push(`${id} is allowed in scripts/check-audit-ignores.mjs but no longer ignored: remove it there too`);
    }
  }
  for (const id of actual.filter((entry) => allowed[entry])) {
    const { package: name, vulnerableUpTo } = allowed[id];
    const versions = lockfileVersions(lockfileText, name);
    const vulnerable = versions.filter((version) => compareVersions(version, vulnerableUpTo) <= 0);
    if (vulnerable.length === 0) {
      problems.push(
        `${id}: no vulnerable ${name} (<= ${vulnerableUpTo}) is installed any more (lockfile has ${versions.join(", ") || "none"}); delete the ignore`,
      );
    }
    if (reportedGhsas && !reportedGhsas.includes(id)) {
      problems.push(`${id}: pnpm audit --prod no longer reports it; ${REMOVAL_STEPS.replaceAll("<package>", name)}`);
    }
  }
  return problems;
}

/** The steps that retire an exception, printed with every failure that means it can go. */
export const REMOVAL_STEPS =
  "upgrade the package (pnpm update --recursive <package>, or bump the parent that pins it), regenerate the lockfile with pnpm install, delete the entry from auditConfig.ignoreGhsas in pnpm-workspace.yaml and from ALLOWED_AUDIT_IGNORES in scripts/check-audit-ignores.mjs, and delete its section in docs/security/audit-exceptions.md";

/** True for a plain x.y.z release (no pre-release suffix). */
function isStableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * Problems for the registry check: for each allowed and ignored advisory, the stable versions the registry publishes
 * above its vulnerable range (`registryVersions` maps a package name to every published version, or is missing it when
 * the lookup failed, which is itself a problem so the watch never passes silently).
 */
export function registryProblems({ ignored, registryVersions, allowed = ALLOWED_AUDIT_IGNORES }) {
  const problems = [];
  for (const id of [...ignored].sort().filter((entry) => allowed[entry])) {
    const { package: name, vulnerableUpTo } = allowed[id];
    const versions = registryVersions[name];
    if (!Array.isArray(versions)) {
      problems.push(`${id}: could not read the published versions of ${name} from the npm registry`);
      continue;
    }
    const patched = versions
      .filter((version) => isStableVersion(version) && compareVersions(version, vulnerableUpTo) > 0)
      .sort(compareVersions);
    if (patched.length > 0) {
      problems.push(
        `${id}: ${name} ${patched.at(-1)} is published (vulnerable range is <= ${vulnerableUpTo}); ${REMOVAL_STEPS.replaceAll("<package>", name)}`,
      );
    }
  }
  return problems;
}

/** Every published version of `name`, from `npm view <name> versions --json`; undefined when the lookup fails. */
function publishedVersions(name) {
  const result = spawnSync("npm", ["view", name, "versions", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : undefined;
  } catch {
    return undefined;
  }
}

/** This repository's pnpm-workspace.yaml and pnpm-lock.yaml texts. */
export function readWorkspaceFiles() {
  return {
    workspaceYaml: readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"),
    lockfileText: readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"),
  };
}

/** The GHSA ids `pnpm audit --prod` reports for this workspace with the ignore list removed (a temporary copy). */
function reportedWithoutIgnores(workspaceYaml) {
  const directory = mkdtempSync(join(tmpdir(), "wi-audit-ignores-"));
  try {
    copyFileSync(join(ROOT, "package.json"), join(directory, "package.json"));
    copyFileSync(join(ROOT, "pnpm-lock.yaml"), join(directory, "pnpm-lock.yaml"));
    writeFileSync(join(directory, "pnpm-workspace.yaml"), withoutAuditConfig(workspaceYaml));
    const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
      cwd: directory,
      encoding: "utf8",
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`pnpm audit --json did not return JSON (exit ${result.status}): ${result.stderr.trim()}`, {
        cause: error,
      });
    }
    if (!report.advisories) throw new Error(`pnpm audit --json returned no advisories field (exit ${result.status})`);
    return Object.values(report.advisories).map((advisory) => advisory.github_advisory_id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const offline = process.argv.includes("--offline");
  const registry = process.argv.includes("--registry");
  if (offline && registry) throw new Error("--offline and --registry cannot be combined");
  const { workspaceYaml, lockfileText } = readWorkspaceFiles();
  const ignored = parseIgnoreGhsas(workspaceYaml);
  const reportedGhsas = offline || ignored.length === 0 ? null : reportedWithoutIgnores(workspaceYaml);
  const problems = auditIgnoreProblems({ ignored, lockfileText, reportedGhsas });
  if (registry) {
    const names = [
      ...new Set(ignored.filter((id) => ALLOWED_AUDIT_IGNORES[id]).map((id) => ALLOWED_AUDIT_IGNORES[id].package)),
    ];
    const registryVersions = Object.fromEntries(names.map((name) => [name, publishedVersions(name)]));
    problems.push(...registryProblems({ ignored, registryVersions }));
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`audit-ignores: ${problem}`);
    console.error("audit-ignores: see docs/security/audit-exceptions.md");
    process.exit(1);
  }
  console.log(
    `audit-ignores: ${ignored.length} exception(s), each still needed${offline ? " (offline: audit not re-run)" : registry ? " (no patched release published)" : ""}: ${ignored.join(", ") || "none"}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

#!/usr/bin/env node
// Run by hand (`node scripts/generate-upgrade-fixtures.mjs`); CI never runs it. Needs network access for the release commits.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fingerprintDatabase, EXCLUDED_TABLES, FTS_SHADOW_SUFFIXES } from "../tests/fixtures/upgrade/fingerprint.mjs";
import process from "node:process";
import console from "node:console";

/** Bump when the seed data or the manifest shape changes. */
const GENERATOR_VERSION = 1;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "tests/fixtures/upgrade");
const seedScript = join(fixtureDirectory, "seed.mjs");
const BUILD_PACKAGES = ["core", "project-policy", "shared", "schema", "storage"];
// The schema alone (~285 objects, one page each) is ~750 KB, so the 500 KB target is not reachable.
const MAX_FIXTURE_BYTES = 1024 * 1024;

/** `privateBlocks`: whether that release redacts <private> blocks (introduced after 1.6.8). */
const SOURCES = [
  {
    schemaVersion: 31,
    sourceVersion: "1.6.8",
    commit: "8719ad44fd731dff319ca3b7a882f90ab9a9f6eb",
    privateBlocks: false,
  },
  {
    schemaVersion: 32,
    sourceVersion: "1.6.21",
    commit: "6889ee0fa9be51a8fec24a1af686c8cab2fdf4de",
    privateBlocks: true,
  },
  {
    schemaVersion: 33,
    sourceVersion: "1.6.51",
    commit: "28b56a85e1fe7fee5bae8e4d9306fa5904493891",
    privateBlocks: true,
  },
  {
    schemaVersion: 34,
    sourceVersion: "1.6.63",
    commit: "2e6b8ad4fd2567984b4ce98178ba3fb4873f59e2",
    privateBlocks: true,
  },
  {
    schemaVersion: 35,
    sourceVersion: "1.6.64",
    commit: "9033dddcd7bb8b522a58f402f0bcab658188ca8b",
    privateBlocks: true,
  },
  {
    schemaVersion: 36,
    sourceVersion: "1.6.70",
    commit: "c5e646cdce9601cf363ab9fda3d78420026b5ef2",
    privateBlocks: true,
  },
  {
    schemaVersion: 37,
    sourceVersion: "1.6.75",
    commit: "b6f063e32aaa0297456bdcd9ed665a493a84aca9",
    privateBlocks: true,
  },
  {
    schemaVersion: 38,
    sourceVersion: "1.6.78",
    commit: "43dc71661fa57d5053950be3c4dfa6d4c62bb85d",
    privateBlocks: true,
  },
  {
    schemaVersion: 39,
    sourceVersion: "1.6.79",
    commit: "507dc46e4317fe90bdd2f4587dba273ae9a7eda8",
    privateBlocks: true,
  },
  {
    schemaVersion: 40,
    sourceVersion: "1.6.82",
    commit: "113df4c6078e99e4892ece14423447a199abc983",
    privateBlocks: true,
  },
];

function run(command, args, cwd, label = command) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`${label} failed in ${cwd}:\n${error.stdout ?? ""}${error.stderr ?? error.message}`, {
      cause: error,
    });
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureCommit(commit) {
  const present = () => {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repositoryRoot, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!present()) run("git", ["fetch", "--depth=1", "origin", commit], repositoryRoot, "git fetch");
  if (!present()) throw new Error(`Commit ${commit} is not available.`);
}

function generate(source, workRoot) {
  const worktree = join(workRoot, `release-${source.sourceVersion}`);
  const rawDatabase = join(workRoot, `schema-${source.schemaVersion}.sqlite`);
  ensureCommit(source.commit);
  let added = false;
  try {
    run("git", ["worktree", "add", "--detach", worktree, source.commit], repositoryRoot, "git worktree add");
    added = true;
    const version = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")).version;
    if (version !== source.sourceVersion)
      throw new Error(`Expected version ${source.sourceVersion}, found ${version}.`);
    run("pnpm", ["install", "--frozen-lockfile"], worktree, "pnpm install");
    for (const name of BUILD_PACKAGES) run("pnpm", ["build"], join(worktree, "packages", name), `pnpm build (${name})`);
    const seeded = run("node", [seedScript, worktree, rawDatabase, source.privateBlocks ? "1" : "0"], workRoot, "seed");
    const { latestSchemaVersion } = JSON.parse(seeded.trim().split("\n").at(-1));
    if (latestSchemaVersion !== source.schemaVersion) {
      throw new Error(
        `Release ${source.sourceVersion} has schema ${latestSchemaVersion}, expected ${source.schemaVersion}.`,
      );
    }
    return {
      rawDatabase,
      tools: {
        node: process.version,
        pnpm: run("pnpm", ["--version"], worktree).trim(),
      },
    };
  } finally {
    if (added) {
      try {
        run("git", ["worktree", "remove", "--force", worktree], repositoryRoot, "git worktree remove");
      } catch (error) {
        console.error(String(error));
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    run("git", ["worktree", "prune"], repositoryRoot, "git worktree prune");
  }
}

function finishDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function migrationVersions(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").get();
    if (check.integrity_check !== "ok") throw new Error(`integrity_check: ${check.integrity_check}`);
    return db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
  } finally {
    db.close();
  }
}

const workRoot = mkdtempSync(join(tmpdir(), "wi-upgrade-fixtures-"));
const manifest = {
  generatorVersion: GENERATOR_VERSION,
  fingerprint: {
    description:
      "Per table: columns, row count and sha256 over rows in rowid order (primary-key order for WITHOUT ROWID), each row a JSON array of type-tagged values (i: integer, r: real, s: text, b: blob hex, null). Computed by tests/fixtures/upgrade/fingerprint.mjs with the current node:sqlite, read-only, right after generation.",
    excludedTables: ["sqlite_%", ...EXCLUDED_TABLES, ...FTS_SHADOW_SUFFIXES.map((suffix) => `<fts5 table>${suffix}`)],
  },
  fixtures: [],
};
try {
  for (const source of SOURCES) {
    console.log(`\n== schema ${source.schemaVersion}: ${source.sourceVersion} (${source.commit.slice(0, 8)})`);
    const { rawDatabase, tools } = generate(source, workRoot);
    finishDatabase(rawDatabase);
    const file = `schema-${source.schemaVersion}.sqlite`;
    const target = join(fixtureDirectory, file);
    copyFileSync(rawDatabase, target);
    chmodSync(target, 0o644);
    const versions = migrationVersions(target);
    if (Math.max(...versions) !== source.schemaVersion)
      throw new Error(`${file}: max migration ${Math.max(...versions)}.`);
    const bytes = statSync(target).size;
    if (bytes > MAX_FIXTURE_BYTES) console.warn(`WARNING: ${file} is ${bytes} bytes (> ${MAX_FIXTURE_BYTES}).`);
    manifest.fixtures.push({
      file,
      schemaVersion: source.schemaVersion,
      sourceVersion: source.sourceVersion,
      sourceCommit: source.commit,
      generatorVersion: GENERATOR_VERSION,
      bytes,
      sha256: sha256File(target),
      migrationVersions: versions,
      build: tools,
      containsPrivateBlockRedactions: source.privateBlocks,
      fingerprint: fingerprintDatabase(target),
    });
    // Read-only opens of a WAL database leave empty -wal/-shm files behind; only the main file is a fixture.
    for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  }
  writeFileSync(join(fixtureDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("\nSummary");
  for (const fixture of manifest.fixtures) {
    console.log(
      `  ${fixture.file}  v${fixture.sourceVersion}  ${fixture.bytes} bytes  ${Object.keys(fixture.fingerprint).length} tables  sha256 ${fixture.sha256.slice(0, 12)}`,
    );
  }
} finally {
  rmSync(workRoot, { recursive: true, force: true });
  if (existsSync(workRoot)) console.error(`Could not remove ${workRoot}`);
}

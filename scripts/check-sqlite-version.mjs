#!/usr/bin/env node
/** Exits 1 when the running Node.js bundles a SQLite with the WAL-reset corruption bug (fixed in 3.51.3, 3.50.7, 3.44.6). */
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "../..");

export async function checkBundledSqlite(version = process.versions.sqlite ?? "") {
  const { assessSqliteWalResetFix } = await import(
    pathToFileURL(resolve(repositoryRoot, "packages/shared/dist/sqlite-version.js")).href
  );
  return assessSqliteWalResetFix(version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkBundledSqlite();
  console.log(`Node.js ${process.versions.node} bundles SQLite ${result.version || "(unknown)"}`);
  if (result.affected) {
    const fix = result.fixedIn ? ` Use a Node.js whose SQLite is ${result.fixedIn} or newer.` : "";
    console.error(
      `SQLite ${result.version || "(unknown)"} has the WAL-reset corruption bug (fixed in 3.51.3, 3.50.7, 3.44.6).${fix}`,
    );
    process.exitCode = 1;
  }
}

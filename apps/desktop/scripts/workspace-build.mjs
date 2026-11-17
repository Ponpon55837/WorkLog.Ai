/**
 * The workspace build that `pnpm package:desktop` runs before packaging, so a local package is one command: the root
 * `scripts/build.mjs` (what `pnpm build` runs), started with this Node so no `pnpm` on PATH is needed. CI builds in its
 * own step and passes `--skip-build`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

/**
 * Runs the workspace build in `repositoryRoot` unless `skip`; returns its duration in seconds, or undefined when skipped.
 * Throws when the build fails, so nothing is packaged from a stale or partial `dist/`.
 */
export function runWorkspaceBuild({ repositoryRoot, skip, spawn = spawnSync, now = Date.now }) {
  if (skip) return undefined;
  const startedAt = now();
  const result = spawn(process.execPath, [join(repositoryRoot, "scripts", "build.mjs")], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`workspace build could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`workspace build failed (exit ${result.status ?? result.signal})`);
  return Number(((now() - startedAt) / 1000).toFixed(1));
}

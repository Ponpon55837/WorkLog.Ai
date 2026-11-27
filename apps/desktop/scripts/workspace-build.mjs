import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

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

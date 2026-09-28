import { spawnSync } from "node:child_process";
import { runPnpm } from "./run-pnpm.mjs";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const markerPath = resolve(repositoryRoot, ".work-intelligence-build-in-progress");

function markerOwnerState() {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof marker.pid !== "number" || !Number.isInteger(marker.pid) || marker.pid <= 0) return "unknown";
    try {
      process.kill(marker.pid, 0);
      return "running";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return "stale";
      return "running";
    }
  } catch {
    return "unknown";
  }
}

if (existsSync(markerPath)) {
  const state = markerOwnerState();
  if (state === "running") {
    throw new Error(
      "A Work Intelligence runtime build is already in progress; the existing build marker was preserved.",
    );
  }
  throw new Error(
    state === "stale"
      ? "A previous runtime build stopped before completion. Verify its recorded PID has exited, remove only .work-intelligence-build-in-progress, then rerun pnpm build."
      : "A runtime build marker cannot be verified. Inspect it and remove only .work-intelligence-build-in-progress after confirming no build is active, then rerun pnpm build.",
  );
}

let markerFd;
try {
  markerFd = openSync(markerPath, "wx", 0o600);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
    throw new Error("Another Work Intelligence runtime build acquired the marker; the existing marker was preserved.", {
      cause: error,
    });
  }
  throw error;
}
try {
  writeFileSync(
    markerFd,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), package: "workspace" }),
  );
} finally {
  closeSync(markerFd);
}

const build = runPnpm(["-r", "build"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, WORK_INTELLIGENCE_ROOT_BUILD: "1" },
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const finalize = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/finalize-runtime-build.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (finalize.error) throw finalize.error;
if (finalize.status !== 0) process.exit(finalize.status ?? 1);
rmSync(markerPath, { force: true });

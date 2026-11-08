import { runPnpm } from "./run-pnpm.mjs";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createBuildMarker, removeOwnBuildMarker } from "./build-marker.mjs";
import { finalizeRuntimePackageBuild } from "./runtime-build-finalizer.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceDirectory = resolve(process.cwd());
const markerPath = resolve(repositoryRoot, ".work-intelligence-build-in-progress");
const rootBuildRequested = process.env.WORK_INTELLIGENCE_ROOT_BUILD === "1";
function hasActiveRootBuildMarker() {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker?.package !== "workspace" ||
      typeof marker.pid !== "number" ||
      !Number.isInteger(marker.pid) ||
      marker.pid <= 0
    ) {
      return false;
    }
    process.kill(marker.pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}
const rootBuild = rootBuildRequested && hasActiveRootBuildMarker();
const isManagedPackage = [
  "apps/mcp",
  "packages/core",
  "packages/project-policy",
  "packages/schema",
  "packages/shared",
  "packages/storage",
].some((directory) => resolve(repositoryRoot, directory) === workspaceDirectory);

if (!isManagedPackage) throw new Error("Runtime package build must run from a tracked MCP runtime package.");

// Content of the marker this build created; undefined while a root build owns the marker.
let markerContent;
if (!rootBuild) {
  try {
    markerContent = createBuildMarker(markerPath, workspaceDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "A Work Intelligence runtime build is already in progress; the existing build marker was preserved.",
        { cause: error },
      );
    }
    throw error;
  }
}

// A failed compile or finalize releases this build's own marker so the next build is not blocked.
let status;
try {
  rmSync(resolve(workspaceDirectory, "dist"), { recursive: true, force: true });
  const build = runPnpm(["exec", "tsc", "-p", "tsconfig.json"], { cwd: workspaceDirectory, stdio: "inherit" });
  if (build.error) throw build.error;
  status = build.status ?? 1;
  if (status === 0 && markerContent !== undefined) await finalizeRuntimePackageBuild(repositoryRoot, markerPath);
} catch (error) {
  if (markerContent !== undefined) removeOwnBuildMarker(markerPath, markerContent);
  throw error;
}
if (status !== 0) {
  if (markerContent !== undefined) removeOwnBuildMarker(markerPath, markerContent);
  process.exit(status);
}

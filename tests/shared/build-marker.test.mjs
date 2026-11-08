import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildMarker, removeOwnBuildMarker } from "../../scripts/build-marker.mjs";

const scriptsDirectory = resolve(import.meta.dirname, "../../scripts");
const roots = [];

// The real build scripts run in a scratch repository whose pnpm and finalizer are stubs driven by environment variables.
const stubRunPnpm = `import { writeFileSync } from "node:fs";
import process from "node:process";
export function runPnpm() {
  if (process.env.FIXTURE_REPLACE_MARKER) writeFileSync(process.env.FIXTURE_MARKER_PATH, process.env.FIXTURE_REPLACE_MARKER);
  return { status: Number(process.env.FIXTURE_PNPM_STATUS ?? 0) };
}
`;
const stubPackageFinalizer = `import { rmSync } from "node:fs";
import process from "node:process";
export async function finalizeRuntimePackageBuild(_root, markerPath) {
  if (process.env.FIXTURE_FINALIZE_FAIL) throw new Error("Fixture finalize failed.");
  rmSync(markerPath, { force: true });
}
`;
const stubRootFinalizer = `import process from "node:process";
process.exitCode = Number(process.env.FIXTURE_FINALIZE_STATUS ?? 0);
`;

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-build-marker-test-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages/core"), { recursive: true });
  for (const script of ["build.mjs", "runtime-package-build.mjs", "build-marker.mjs"]) {
    copyFileSync(join(scriptsDirectory, script), join(root, "scripts", script));
  }
  writeFileSync(join(root, "scripts/run-pnpm.mjs"), stubRunPnpm);
  writeFileSync(join(root, "scripts/runtime-build-finalizer.mjs"), stubPackageFinalizer);
  writeFileSync(join(root, "scripts/finalize-runtime-build.mjs"), stubRootFinalizer);
  return { root, markerPath: join(root, ".work-intelligence-build-in-progress") };
}

function run(root, script, cwd, env = {}) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WORK_INTELLIGENCE_ROOT_BUILD: "", ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime build marker", () => {
  it("creates the marker exclusively and removes it only while it holds this build's content", () => {
    const { markerPath } = createRepository();
    const content = createBuildMarker(markerPath, "workspace");
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({ pid: process.pid, package: "workspace" });
    expect(() => createBuildMarker(markerPath, "workspace")).toThrow(expect.objectContaining({ code: "EEXIST" }));
    writeFileSync(markerPath, JSON.stringify({ pid: process.pid, package: "another build" }));
    expect(removeOwnBuildMarker(markerPath, content)).toBe(false);
    expect(existsSync(markerPath)).toBe(true);
    writeFileSync(markerPath, content);
    expect(removeOwnBuildMarker(markerPath, content)).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    expect(removeOwnBuildMarker(markerPath, content)).toBe(false);
  });

  it("clears a direct package build's own marker when compiling or finalizing fails, so the next build runs", () => {
    const { root, markerPath } = createRepository();
    const packageDirectory = join(root, "packages/core");
    expect(run(root, "runtime-package-build.mjs", packageDirectory, { FIXTURE_PNPM_STATUS: "2" }).status).toBe(2);
    expect(existsSync(markerPath)).toBe(false);

    const finalizeFailure = run(root, "runtime-package-build.mjs", packageDirectory, { FIXTURE_FINALIZE_FAIL: "1" });
    expect(finalizeFailure.status).not.toBe(0);
    expect(finalizeFailure.stderr).toContain("Fixture finalize failed.");
    expect(existsSync(markerPath)).toBe(false);

    expect(run(root, "runtime-package-build.mjs", packageDirectory).status).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("leaves a marker it does not own: another build's, one replaced mid-build, or the active root build's", () => {
    const { root, markerPath } = createRepository();
    const packageDirectory = join(root, "packages/core");
    const other = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", package: "other" });
    writeFileSync(markerPath, other);
    const blocked = run(root, "runtime-package-build.mjs", packageDirectory, { FIXTURE_PNPM_STATUS: "1" });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("already in progress");
    expect(readFileSync(markerPath, "utf8")).toBe(other);

    rmSync(markerPath);
    const replaced = run(root, "runtime-package-build.mjs", packageDirectory, {
      FIXTURE_PNPM_STATUS: "1",
      FIXTURE_MARKER_PATH: markerPath,
      FIXTURE_REPLACE_MARKER: other,
    });
    expect(replaced.status).toBe(1);
    expect(readFileSync(markerPath, "utf8")).toBe(other);

    // Inside a root build the package build uses the root marker and never removes it.
    const rootMarker = JSON.stringify({
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      package: "workspace",
    });
    writeFileSync(markerPath, rootMarker);
    const inRoot = run(root, "runtime-package-build.mjs", packageDirectory, {
      FIXTURE_PNPM_STATUS: "1",
      WORK_INTELLIGENCE_ROOT_BUILD: "1",
    });
    expect(inRoot.status).toBe(1);
    expect(readFileSync(markerPath, "utf8")).toBe(rootMarker);
  });

  it("clears the root build's own marker when a package build or finalize fails, and keeps the existing-marker guard", () => {
    const { root, markerPath } = createRepository();
    expect(run(root, "build.mjs", root, { FIXTURE_PNPM_STATUS: "3" }).status).toBe(3);
    expect(existsSync(markerPath)).toBe(false);
    expect(run(root, "build.mjs", root, { FIXTURE_FINALIZE_STATUS: "4" }).status).toBe(4);
    expect(existsSync(markerPath)).toBe(false);
    expect(run(root, "build.mjs", root).status).toBe(0);
    expect(existsSync(markerPath)).toBe(false);

    const running = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", package: "workspace" });
    writeFileSync(markerPath, running);
    const blocked = run(root, "build.mjs", root);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("already in progress");
    expect(readFileSync(markerPath, "utf8")).toBe(running);
  });
});

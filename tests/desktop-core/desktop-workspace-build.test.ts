import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkspaceBuild, type SpawnLike } from "../../apps/desktop/scripts/workspace-build.mjs";

const repositoryRoot = "/synthetic/repository";

function recordingSpawn(status: number | null, error?: Error): { spawn: SpawnLike; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push([command, ...args]);
    return { status, ...(error ? { error } : {}) };
  };
  return { spawn, calls };
}

describe("the workspace build before packaging", () => {
  it("runs the root build script with this Node by default and returns its seconds", () => {
    const { spawn, calls } = recordingSpawn(0);
    const times = [1_000, 3_450];
    const seconds = runWorkspaceBuild({ repositoryRoot, skip: false, spawn, now: () => times.shift() ?? 0 });
    expect(calls).toEqual([[process.execPath, join(repositoryRoot, "scripts", "build.mjs")]]);
    expect(seconds).toBe(2.5);
  });

  it("does not build with --skip-build", () => {
    const { spawn, calls } = recordingSpawn(0);
    expect(runWorkspaceBuild({ repositoryRoot, skip: true, spawn })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("throws when the build fails, so nothing is packaged", () => {
    const { spawn } = recordingSpawn(2);
    expect(() => runWorkspaceBuild({ repositoryRoot, skip: false, spawn })).toThrow("workspace build failed (exit 2)");
  });

  it("throws when the build cannot start", () => {
    const { spawn } = recordingSpawn(null, new Error("spawn ENOENT"));
    expect(() => runWorkspaceBuild({ repositoryRoot, skip: false, spawn })).toThrow(
      "workspace build could not start: spawn ENOENT",
    );
  });
});

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { securePrivateDirectory } from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

export interface DesktopRuntimeFixtures {
  readonly parent: string;
}

declare module "vitest" {
  interface ProvidedContext {
    desktopRuntimeFixtures: DesktopRuntimeFixtures;
  }
}

/**
 * Locks the fixture parent like the App's real root (the runner's temp folder grants BUILTIN\Users write access, which the
 * ACL check refuses), once per run: locking per test file made each file's first test the slowest (5.7 s on Windows).
 * `realpath.native` keeps comparisons stable across macOS /private/var and Windows 8.3 names.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const parent = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-runtime-tests-")));
  const lockStart = performance.now();
  securePrivateDirectory(parent);
  console.log(`[desktop-core global setup] directory lock ${Math.round(performance.now() - lockStart)} ms`);

  project.provide("desktopRuntimeFixtures", { parent });
  return async () => {
    await fs.rm(parent, { recursive: true, force: true });
  };
}

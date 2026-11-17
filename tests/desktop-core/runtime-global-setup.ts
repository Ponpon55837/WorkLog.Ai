import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { securePrivateDirectory } from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

/** What every worker of the desktop-core run receives through `inject("desktopRuntimeFixtures")`. */
export interface DesktopRuntimeFixtures {
  /** The locked directory that holds every launcher root of the run (`realpath.native`). */
  readonly parent: string;
}

declare module "vitest" {
  interface ProvidedContext {
    desktopRuntimeFixtures: DesktopRuntimeFixtures;
  }
}

/**
 * Runs once per `vitest run`, before any worker starts: creates the parent directory for the fixture runtimes' roots and
 * locks it like the App's real root (the runner's temp folder grants BUILTIN\Users write access, which the runtime's ACL
 * check refuses). Every folder created inside inherits the locked ACL. Locking it in every test file instead made each
 * file's first fixture test the slowest (5.1 s and 5.7 s measured on Windows). No PowerShell runs here: the fixture
 * suites answer the ACL check with a synthetic descriptor (`fixtureAcl`), and only runtime-windows-acl.test.ts uses the
 * real reader. `realpath.native` so comparisons survive macOS /private/var and Windows 8.3 names.
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

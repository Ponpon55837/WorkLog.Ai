import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { createWindowsAclReader } from "../../packages/desktop-core/src/runtime/index.js";
import { securePrivateDirectory } from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

/** What every worker of the desktop-core run receives through `inject("desktopRuntimeFixtures")`. */
export interface DesktopRuntimeFixtures {
  /** The locked directory that holds every launcher root of the run (`realpath.native`). */
  readonly parent: string;
  /** The one real ACL read of `parent` on Windows (real SID and SDDL, inherited by everything below); absent elsewhere. */
  readonly aclSnapshot?: { readonly currentUserSid: string; readonly sddl: string };
}

declare module "vitest" {
  interface ProvidedContext {
    desktopRuntimeFixtures: DesktopRuntimeFixtures;
  }
}

/**
 * Runs once per `vitest run`, before any worker starts: creates the parent directory for the fixture runtimes' roots and
 * locks it like the App's real root (the runner's temp folder grants BUILTIN\Users write access, which the runtime's ACL
 * check refuses). `icacls` and the one PowerShell ACL read cost seconds on a cold Windows runner; paying them in every
 * test file made each file's first fixture test the slowest (5.1 s and 5.7 s measured). Every folder created inside the
 * parent inherits the locked ACL. `realpath.native` so comparisons survive macOS /private/var and Windows 8.3 names.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const parent = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-runtime-tests-")));
  const lockStart = performance.now();
  securePrivateDirectory(parent);
  const lockMs = Math.round(performance.now() - lockStart);

  let aclSnapshot: DesktopRuntimeFixtures["aclSnapshot"];
  let aclMs = 0;
  if (process.platform === "win32") {
    const readStart = performance.now();
    const { currentUserSid, sddls } = await createWindowsAclReader().read([parent]);
    aclMs = Math.round(performance.now() - readStart);
    aclSnapshot = { currentUserSid, sddl: sddls[0] as string };
  }
  console.log(`[desktop-core global setup] directory lock ${lockMs} ms, ACL read ${aclMs} ms`);

  project.provide("desktopRuntimeFixtures", aclSnapshot === undefined ? { parent } : { parent, aclSnapshot });
  return async () => {
    await fs.rm(parent, { recursive: true, force: true });
  };
}

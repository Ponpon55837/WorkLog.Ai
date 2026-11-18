import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DesktopChildDependencies } from "./desktop-child.js";

/**
 * The test-only hold that keeps the desktop child from opening the database (the smoke test's migration interruption).
 * Nothing but desktop-child's `defaultDependencies` imports this module, and only behind `__WI_DESKTOP_TEST_BUILD__`:
 * a production runtime bundle contains neither this module nor the variable name below (check-production-bundle.mjs
 * proves it for the packaged App's runtime).
 */

/**
 * The name of the variable that holds a child before it opens the database. Two things must both hold: the App's main
 * process sets it only in a test build that is not packaged (`backendTestEnvironment` in apps/desktop/src/main/config.ts;
 * the child environment is an allowlist, so a variable in the user's own environment never reaches it), and this child
 * was bundled as a test runtime (`testBuild`, from `__WI_DESKTOP_TEST_BUILD__`).
 */
export const TEST_HOLD_MIGRATION_ENVIRONMENT = "WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE";

/**
 * The hold for the variable's absolute path `P`, or undefined when `testBuild` is false or the variable is not set. The
 * hold writes the child's pid to `P.held` and waits until the file `P` exists; the smoke test kills the child while it
 * waits, or creates `P` to let the migration go on.
 */
export function migrationHoldFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  testBuild: boolean,
  pollMs = 50,
): DesktopChildDependencies["holdBeforeOpen"] {
  if (!testBuild) return undefined;
  const release = environment[TEST_HOLD_MIGRATION_ENVIRONMENT];
  if (!release || !isAbsolute(release)) return undefined;
  return async (stillStarting) => {
    // Written whole and renamed into place, so a reader that sees the file sees the pid.
    await writeFile(`${release}.held.tmp`, String(process.pid));
    await rename(`${release}.held.tmp`, `${release}.held`);
    while (stillStarting() && !existsSync(release)) await sleep(pollMs);
  };
}

import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DesktopChildDependencies } from "./desktop-child.js";

/** @internal test-only */
export const TEST_HOLD_MIGRATION_ENVIRONMENT = "WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE";

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

import { writeFileSync } from "node:fs";
import type { ManagedStartHold } from "@work-intelligence/desktop-core";

/**
 * The smoke tests' way to end the App in the middle of a port or database change: it writes `<file>.reached` and then
 * never returns, so the commit step stays open until the test kills the process. Only a test build that is not packaged
 * ever creates one (see `pauseOperationFile` in config.ts); every other kind of start passes straight through.
 */
export function operationPause(file: string): ManagedStartHold {
  return async ({ kind }) => {
    if (kind !== "change-port" && kind !== "change-db") return;
    writeFileSync(`${file}.reached`, JSON.stringify({ kind }));
    await new Promise<never>(() => undefined);
  };
}

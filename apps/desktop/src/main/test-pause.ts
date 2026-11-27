import { writeFileSync } from "node:fs";
import type { ManagedStartHold } from "@work-intelligence/desktop-core";

export function operationPause(file: string): ManagedStartHold {
  return async ({ kind }) => {
    if (kind !== "change-port" && kind !== "change-db") return;
    writeFileSync(`${file}.reached`, JSON.stringify({ kind }));
    await new Promise<never>(() => undefined);
  };
}

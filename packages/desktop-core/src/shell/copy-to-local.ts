import type { DesktopCopyResultMessage, DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { RestartOutcome } from "./backend-recovery.js";

/**
 * 「複製到本機磁碟並改用」 (DT-08): the way out when a schema update is refused because the database is on risky storage.
 * It only decides and sequences; every effect comes in through {@link CopyToLocalDeps}, so the unit tests run each
 * failure without Electron. The original file is never written: the copy is made by a preview child that opens it
 * read-only, and the switch is the normal journaled change-db start, with the schema update allowed for the copy (it is
 * local, and the click was the consent).
 */

export const COPY_TO_LOCAL_FAILURES = [
  "no-space",
  "target-exists",
  "target-risky",
  "integrity-failed",
  "copy-failed",
  "start-failed",
] as const;
export type CopyToLocalFailure = (typeof COPY_TO_LOCAL_FAILURES)[number];

/** `COPY_NO_SPACE`, ...: the code the repair page maps to its message. */
export function copyFailureCode(failure: CopyToLocalFailure): string {
  return `COPY_${failure.toUpperCase().replaceAll("-", "_")}`;
}

/** The failure a repair-page error code names, or undefined for any other code. */
export function copyFailureOfCode(code: string | undefined): CopyToLocalFailure | undefined {
  return COPY_TO_LOCAL_FAILURES.find((failure) => copyFailureCode(failure) === code);
}

export type CopyToLocalResult =
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly reason: "cancelled" | "busy" }
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly failure: CopyToLocalFailure;
      readonly errorCode: string;
      /** `start-failed`: the code the backend start on the copy really failed with (absent when the start threw). */
      readonly backendCode?: string;
    };

export interface CopyToLocalDeps {
  /**
   * The App's default data folder (where the copy goes) is itself on a network share, a removable drive or a cloud-sync
   * folder: a copy there would be no safer than the original, so nothing is asked or written.
   */
  readonly targetFolderRisky: () => Promise<boolean>;
  /** The native confirmation (copies to the default data folder, switches, updates the copy, leaves the original). */
  readonly confirm: () => Promise<boolean>;
  /** Bytes of the database file and its `-wal`; the copy is made through SQLite, so both are read. */
  readonly sourceBytes: () => Promise<{ readonly database: number; readonly wal: number }>;
  /** Free bytes on the volume of the target folder; undefined when the OS will not say (the copy then tries anyway). */
  readonly freeBytes: () => Promise<number | undefined>;
  /** A target file name in the App's default data folder that does not exist yet (and overwrites nothing). */
  readonly chooseTarget: () => Promise<string>;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly copyDatabase: (target: string) => Promise<DesktopCopyResultMessage>;
  /** The journaled change-db start on the copy, with the schema update allowed; the settings are written on success. */
  readonly switchTo: (target: string, identity: DesktopDatabaseIdentity) => Promise<RestartOutcome>;
  /** Takes back the copy this run made (only while it is still the file `identity` names). */
  readonly removeCopy: (target: string, identity: DesktopDatabaseIdentity) => void;
  readonly log: (line: string) => void;
}

/** Room kept beyond the file sizes: the copy is made in a staging folder and then linked, and a schema update grows it. */
export const COPY_MARGIN_MIN_BYTES = 64 * 1024 * 1024;
export const COPY_MARGIN_FRACTION = 0.1;

/** The free space a copy needs: the database, its WAL and a margin. */
export function requiredCopyBytes(database: number, wal: number): number {
  return database + wal + Math.max(COPY_MARGIN_MIN_BYTES, Math.ceil(database * COPY_MARGIN_FRACTION));
}

const COPY_STATUS_FAILURE: Record<Exclude<DesktopCopyResultMessage["status"], "ok">, CopyToLocalFailure> = {
  "no-space": "no-space",
  "target-exists": "target-exists",
  "integrity-failed": "integrity-failed",
  failed: "copy-failed",
};

function failed(deps: CopyToLocalDeps, failure: CopyToLocalFailure, backendCode?: string): CopyToLocalResult {
  deps.log(`[shell] copy to local disk failed: ${failure}${backendCode ? ` (${backendCode})` : ""}`);
  return {
    ok: false,
    reason: "failed",
    failure,
    errorCode: copyFailureCode(failure),
    ...(backendCode ? { backendCode } : {}),
  };
}

export async function runCopyToLocal(deps: CopyToLocalDeps): Promise<CopyToLocalResult> {
  try {
    if (await deps.targetFolderRisky()) return failed(deps, "target-risky");
    if (!(await deps.confirm())) return { ok: false, reason: "cancelled" };
    const sizes = await deps.sourceBytes();
    const free = await deps.freeBytes();
    if (free !== undefined && free < requiredCopyBytes(sizes.database, sizes.wal)) return failed(deps, "no-space");
    const target = await deps.chooseTarget();
    await deps.prepareRuntime();
    const copy = await deps.copyDatabase(target);
    if (copy.status !== "ok") return failed(deps, COPY_STATUS_FAILURE[copy.status]);
    if (!copy.identity) return failed(deps, "integrity-failed");
    const identity = copy.identity;
    let outcome: RestartOutcome;
    try {
      outcome = await deps.switchTo(target, identity);
    } catch {
      deps.removeCopy(target, identity);
      return failed(deps, "start-failed");
    }
    if (!outcome.ok) {
      deps.removeCopy(target, identity);
      if (outcome.busy) return { ok: false, reason: "busy" };
      return failed(deps, "start-failed", outcome.code);
    }
    deps.log("[shell] copy to local disk: switched to the copy");
    return { ok: true, target };
  } catch {
    return failed(deps, "copy-failed");
  }
}

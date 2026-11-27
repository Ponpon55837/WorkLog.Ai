import type { DesktopCopyResultMessage, DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { RestartOutcome } from "./backend-recovery.js";

export const COPY_TO_LOCAL_FAILURES = [
  "no-space",
  "target-exists",
  "target-risky",
  "integrity-failed",
  "copy-failed",
  "start-failed",
] as const;
export type CopyToLocalFailure = (typeof COPY_TO_LOCAL_FAILURES)[number];

export function copyFailureCode(failure: CopyToLocalFailure): string {
  return `COPY_${failure.toUpperCase().replaceAll("-", "_")}`;
}

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
      readonly backendCode?: string;
    };

export interface CopyToLocalDeps {
  readonly targetFolderRisky: () => Promise<boolean>;
  readonly confirm: () => Promise<boolean>;
  readonly sourceBytes: () => Promise<{ readonly database: number; readonly wal: number }>;
  readonly freeBytes: () => Promise<number | undefined>;
  readonly chooseTarget: () => Promise<string>;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly copyDatabase: (target: string) => Promise<DesktopCopyResultMessage>;
  readonly switchTo: (target: string, identity: DesktopDatabaseIdentity) => Promise<RestartOutcome>;
  readonly removeCopy: (target: string, identity: DesktopDatabaseIdentity) => void;
  readonly log: (line: string) => void;
}

export const COPY_MARGIN_MIN_BYTES = 64 * 1024 * 1024;
export const COPY_MARGIN_FRACTION = 0.1;

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

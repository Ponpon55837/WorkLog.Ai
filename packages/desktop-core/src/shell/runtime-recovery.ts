import { REINSTALLABLE_CODES } from "../runtime/errors.js";
import { isDeterministicFailure } from "./restart-policy.js";

export interface RuntimeRecoveryInputs {
  /** The App provisions its own runtime (packaged); otherwise there is nothing to reinstall from. */
  readonly canReinstall: boolean;
  /** The code the failed start reported. */
  readonly failureCode: string;
  /** A reinstall was already tried since this App started. */
  readonly alreadyAttempted: boolean;
}

export type RuntimeRecoveryDecision = "none" | "verify-reinstall-and-retry";

/**
 * Whether a start that failed should verify the installed runtime, reinstall it from the bundle if its content is wrong,
 * and start once more. Only a runtime the launch could not find (`RUNTIME_MISSING`) or whose content is wrong
 * (`REINSTALLABLE_CODES`) qualifies, and only once per App start, so a runtime that keeps failing goes to the repair flow
 * instead of looping. A permission or ACL refusal is deterministic: copying the files again cannot fix it, so it goes to
 * the repair flow with its true reason. The verification decides the rest: a runtime that verifies fine means the
 * runtime was not the cause, and only a content problem leads to a reinstall.
 */
export function decideRuntimeRecovery(inputs: RuntimeRecoveryInputs): RuntimeRecoveryDecision {
  if (!inputs.canReinstall || inputs.alreadyAttempted) return "none";
  return isRuntimeReinstallable(inputs.failureCode) ? "verify-reinstall-and-retry" : "none";
}

/** Whether a failed start with this code may be a runtime whose files a reinstall would fix. */
export function isRuntimeReinstallable(failureCode: string): boolean {
  return failureCode === "RUNTIME_MISSING" || REINSTALLABLE_CODES.has(failureCode);
}

/**
 * Whether a failed start with this code is final for this App start: no automatic restart and no reinstall will follow,
 * so the App stays in NEEDS_REPAIR until the user acts. A runtime that may still be reinstalled is not final yet.
 */
export function isSettledRepairFailure(failureCode: string): boolean {
  return isDeterministicFailure(failureCode) && !isRuntimeReinstallable(failureCode);
}

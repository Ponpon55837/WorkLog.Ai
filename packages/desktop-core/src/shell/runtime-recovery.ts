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
 * and start once more. Only `RUNTIME_MISSING` (the backend launch refused the runtime) qualifies, and only once per App
 * start, so a runtime that keeps failing goes to the repair flow instead of looping. The verification decides the rest:
 * a permission or ACL problem is thrown by it (never "fixed" by copying again), a runtime that verifies fine means the
 * runtime was not the cause, and only a content problem leads to a reinstall.
 */
export function decideRuntimeRecovery(inputs: RuntimeRecoveryInputs): RuntimeRecoveryDecision {
  if (!inputs.canReinstall || inputs.alreadyAttempted) return "none";
  return inputs.failureCode === "RUNTIME_MISSING" ? "verify-reinstall-and-retry" : "none";
}

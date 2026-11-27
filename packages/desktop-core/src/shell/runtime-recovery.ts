import { REINSTALLABLE_CODES } from "../runtime/errors.js";
import { isDeterministicFailure } from "./restart-policy.js";

export interface RuntimeRecoveryInputs {
  readonly canReinstall: boolean;
  readonly failureCode: string;
  readonly alreadyAttempted: boolean;
}

export type RuntimeRecoveryDecision = "none" | "verify-reinstall-and-retry";

export function decideRuntimeRecovery(inputs: RuntimeRecoveryInputs): RuntimeRecoveryDecision {
  if (!inputs.canReinstall || inputs.alreadyAttempted) return "none";
  return isRuntimeReinstallable(inputs.failureCode) ? "verify-reinstall-and-retry" : "none";
}

export function isRuntimeReinstallable(failureCode: string): boolean {
  return failureCode === "RUNTIME_MISSING" || REINSTALLABLE_CODES.has(failureCode);
}

export function isSettledRepairFailure(failureCode: string): boolean {
  return isDeterministicFailure(failureCode) && !isRuntimeReinstallable(failureCode);
}

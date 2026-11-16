import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export type SecondInstanceDecision = "focus-repair" | "open-dashboard" | "open-repair";

export interface SecondInstanceInputs {
  readonly repairWindowOpen: boolean;
  readonly owner: ServiceOwnerState;
  /** A verified backend is serving the Dashboard right now. */
  readonly backendRunning: boolean;
}

/**
 * What the running App does when the user starts it a second time: an open repair window just comes forward, a healthy
 * managed service opens the Dashboard, anything else opens the repair window so the user is never left with nothing.
 */
export function decideSecondInstance(inputs: SecondInstanceInputs): SecondInstanceDecision {
  if (inputs.repairWindowOpen) return "focus-repair";
  if (inputs.owner === "MANAGED" && inputs.backendRunning) return "open-dashboard";
  return "open-repair";
}

import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export type SecondInstanceDecision = "focus-repair" | "open-dashboard" | "open-repair" | "defer-dashboard";

/** What the second launch asked for: a plain launch, or `--open-dashboard`. */
export type SecondInstanceRequest = "open" | "open-dashboard";

/** Owner states in which a service is being prepared, stopped or started: not ready, and not broken either. */
const TRANSITIONAL_OWNER_STATES: readonly ServiceOwnerState[] = ["PREPARING", "QUIESCING", "STARTING"];

export interface SecondInstanceInputs {
  readonly repairWindowOpen: boolean;
  readonly owner: ServiceOwnerState;
  /** A verified backend is serving the Dashboard right now. */
  readonly backendRunning: boolean;
  readonly request: SecondInstanceRequest;
  /** The first start has not finished yet: the backend is still being started and the owner is not known. */
  readonly starting: boolean;
}

/**
 * What the running App does when the user starts it a second time: an open repair window just comes forward, a healthy
 * managed service opens the Dashboard, anything else opens the repair window so the user is never left with nothing.
 * An explicit `--open-dashboard` that arrives while the first start is still running, or while the owner is PREPARING,
 * QUIESCING or STARTING, is deferred instead: the repair window would be wrong for a service that is simply not ready
 * yet, and the Dashboard opens once it is (the first start does it, or the owner reaching MANAGED later).
 */
export function decideSecondInstance(inputs: SecondInstanceInputs): SecondInstanceDecision {
  if (inputs.repairWindowOpen) return "focus-repair";
  if (inputs.owner === "MANAGED" && inputs.backendRunning) return "open-dashboard";
  if (inputs.request === "open-dashboard" && (inputs.starting || TRANSITIONAL_OWNER_STATES.includes(inputs.owner))) {
    return "defer-dashboard";
  }
  return "open-repair";
}

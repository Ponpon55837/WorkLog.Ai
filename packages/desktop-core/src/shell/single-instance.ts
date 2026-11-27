import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export type SecondInstanceDecision = "focus-repair" | "open-dashboard" | "open-repair" | "defer-dashboard";

export type SecondInstanceRequest = "open" | "open-dashboard";

const TRANSITIONAL_OWNER_STATES: readonly ServiceOwnerState[] = ["PREPARING", "QUIESCING", "STARTING"];

export interface SecondInstanceInputs {
  readonly repairWindowOpen: boolean;
  readonly owner: ServiceOwnerState;
  readonly backendRunning: boolean;
  readonly request: SecondInstanceRequest;
  readonly starting: boolean;
}

export function decideSecondInstance(inputs: SecondInstanceInputs): SecondInstanceDecision {
  if (inputs.repairWindowOpen) return "focus-repair";
  if (inputs.owner === "MANAGED" && inputs.backendRunning) return "open-dashboard";
  if (inputs.request === "open-dashboard" && (inputs.starting || TRANSITIONAL_OWNER_STATES.includes(inputs.owner))) {
    return "defer-dashboard";
  }
  return "open-repair";
}

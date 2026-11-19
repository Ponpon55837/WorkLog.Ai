// The reader lives in shared so the Web system status judges a host by the very same code (see that module).
export {
  classifyHostObservation,
  readCurrentContractFingerprint,
  readHostObservations,
  type HostObservation,
  type HostObservationState,
} from "@work-intelligence/shared/agent-observations";

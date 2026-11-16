/** ServiceOwner states (R4 §4.1). `as const` array so the zod schema and the table share one source. */
export const SERVICE_OWNER_STATES = [
  "UNCONFIGURED",
  "EXTERNAL",
  "PREPARING",
  "QUIESCING",
  "STARTING",
  "MANAGED",
  "NEEDS_REPAIR",
] as const;

/** Who controls the HTTP/API child process right now. */
export type ServiceOwnerState = (typeof SERVICE_OWNER_STATES)[number];

/** One legal edge of the state machine with the reason it exists. */
export interface TransitionEdge {
  readonly from: ServiceOwnerState;
  readonly to: ServiceOwnerState;
  readonly rationale: string;
}

/**
 * The legal transitions as data. Edges into EXTERNAL from a non-initial state are "restore" edges: they hand the
 * old service back, so they are additionally blocked once a migration started (ADR-22, see {@link assertTransition}).
 */
export const TRANSITION_EDGES: readonly TransitionEdge[] = [
  { from: "UNCONFIGURED", to: "PREPARING", rationale: "first-time takeover or setup was requested" },
  {
    from: "UNCONFIGURED",
    to: "EXTERNAL",
    rationale: "detection found an externally managed service and the user keeps it",
  },
  { from: "UNCONFIGURED", to: "NEEDS_REPAIR", rationale: "detection found conflicting or unidentifiable state" },
  { from: "EXTERNAL", to: "PREPARING", rationale: "user confirmed the takeover preview" },
  { from: "EXTERNAL", to: "NEEDS_REPAIR", rationale: "external service conflict or incompatible DB discovered" },
  { from: "PREPARING", to: "QUIESCING", rationale: "preflight passed; old service must be stopped" },
  { from: "PREPARING", to: "STARTING", rationale: "no old service is running, nothing to quiesce" },
  { from: "PREPARING", to: "EXTERNAL", rationale: "cancel before any change: nothing was touched, old service stays" },
  {
    from: "PREPARING",
    to: "MANAGED",
    rationale: "re-operation (port/DB change) cancelled before any change: current child is untouched",
  },
  { from: "PREPARING", to: "NEEDS_REPAIR", rationale: "preflight or backup failed in an unexpected way" },
  { from: "QUIESCING", to: "STARTING", rationale: "old service stopped and port released" },
  {
    from: "QUIESCING",
    to: "EXTERNAL",
    rationale: "cancel or failure: restore old registration and run state (only if migration not started)",
  },
  { from: "QUIESCING", to: "NEEDS_REPAIR", rationale: "old process tree could not be proven stopped" },
  {
    from: "STARTING",
    to: "MANAGED",
    rationale: "child identity, DB identity and HTTP readiness verified; ownership committed",
  },
  {
    from: "STARTING",
    to: "EXTERNAL",
    rationale: "child failed before migration: restore previous service (only if migration not started)",
  },
  { from: "STARTING", to: "NEEDS_REPAIR", rationale: "child failed or DB compatibility is uncertain" },
  { from: "MANAGED", to: "PREPARING", rationale: "re-operation such as change port or database" },
  { from: "MANAGED", to: "EXTERNAL", rationale: "user hands the service back (only if migration not started)" },
  { from: "MANAGED", to: "NEEDS_REPAIR", rationale: "managed service lost its identity or DB changed underneath" },
  { from: "NEEDS_REPAIR", to: "PREPARING", rationale: "repair flow retries the takeover" },
  {
    from: "NEEDS_REPAIR",
    to: "EXTERNAL",
    rationale: "user returns to external management (only if migration not started)",
  },
  { from: "NEEDS_REPAIR", to: "UNCONFIGURED", rationale: "user discards the configuration and starts over" },
];

/** Adjacency view of {@link TRANSITION_EDGES}. */
export const TRANSITION_TABLE: ReadonlyMap<ServiceOwnerState, ReadonlySet<ServiceOwnerState>> = buildTable();

/** Raised for an edge that is not in the table. */
export class InvalidTransitionError extends Error {
  readonly from: ServiceOwnerState;
  readonly to: ServiceOwnerState;

  constructor(from: ServiceOwnerState, to: ServiceOwnerState) {
    super(`illegal ServiceOwner transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Raised when a transition would restore the old service after migration started (ADR-22). */
export class RestoreForbiddenError extends Error {
  readonly from: ServiceOwnerState;

  constructor(from: ServiceOwnerState) {
    super(`restoring the previous service from ${from} is forbidden after migration started; repair is required`);
    this.name = "RestoreForbiddenError";
    this.from = from;
  }
}

/** True when the table allows `from -> to` (ignores the migration guard). */
export function isLegalTransition(from: ServiceOwnerState, to: ServiceOwnerState): boolean {
  return TRANSITION_TABLE.get(from)?.has(to) ?? false;
}

/** Throws a typed error unless `from -> to` is legal given whether migration already started. */
export function assertTransition(from: ServiceOwnerState, to: ServiceOwnerState, migrationStarted: boolean): void {
  if (!isLegalTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (migrationStarted && to === "EXTERNAL") throw new RestoreForbiddenError(from);
}

function buildTable(): ReadonlyMap<ServiceOwnerState, ReadonlySet<ServiceOwnerState>> {
  const table = new Map<ServiceOwnerState, Set<ServiceOwnerState>>();
  for (const state of SERVICE_OWNER_STATES) table.set(state, new Set());
  for (const edge of TRANSITION_EDGES) table.get(edge.from)?.add(edge.to);
  return table;
}

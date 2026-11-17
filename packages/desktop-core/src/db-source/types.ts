import type { StorageRiskResult } from "./storage-risk.js";

/**
 * Composite identity of a database file (never a path string or project count alone): see the DB identity strategy.
 * `identity-schema.ts` holds the matching zod schema.
 */
export interface DatabaseIdentity {
  realPath: string;
  fileId: { device: string; inode: string } | null;
  lineageId: string | null;
}

/** Where a candidate database path came from, in the order the resolver may weigh them. */
export type DbSourceKind =
  | "desktop-committed"
  | "explicit-selection"
  | "legacy-service"
  | "plugin-link"
  | "agent-mcp"
  | "standalone-default"
  | "checkout-default";

export type DbProbeStatus = "missing" | "offline" | "denied" | "unreadable" | "unsupported-schema" | "ok";

/** Statuses a group can carry: `conflict` is assigned only by the resolver, never by a probe. */
export type DbGroupStatus = DbProbeStatus | "conflict";

/** Result of one read-only probe; the statuses stay distinct so the UI can explain each one. */
export interface DbProbeResult {
  status: DbProbeStatus;
  identity?: DatabaseIdentity;
  schemaVersion?: number;
  projectCount?: number;
  detail?: string;
}

/**
 * Injected so the resolver is pure; the real probe opens the file read-only and never writes.
 *
 * Concurrency contract (C-05/C-06): `resolveDbSource` starts probes together (bounded by its `concurrency`
 * option), which only overlaps work when a probe is truly asynchronous. A probe built on synchronous SQLite
 * (`node:sqlite` `DatabaseSync`) blocks the thread it runs on for the whole query and gains nothing from
 * `Promise.all`, so the desktop host MUST run such a probe off the Electron main/UI thread (worker thread or child
 * process) and expose it here as an async function; otherwise a slow or offline volume freezes the UI.
 */
export type DbProbe = (absolutePath: string) => Promise<DbProbeResult>;

export interface DbCandidate {
  kind: DbSourceKind;
  /** The value exactly as found in the source (settings, env, link file). */
  rawValue: string;
  /** The directory a relative rawValue was resolved against. */
  resolutionBase: string;
  absolutePath: string;
  /** Whether the service/config entry belongs to the current OS user; `"unknown"` when it cannot be told. */
  managedByCurrentUser: boolean | "unknown";
  /** Set when the raw value cannot be turned into a file path (`:memory:`, drive-relative); never probed. */
  invalidReason?: string;
}

/** Preview data only: shown to help the user choose, never used for identity. */
export interface DbPreview {
  schemaVersion?: number;
  projectCount?: number;
}

export interface ResolvedCandidate extends DbCandidate {
  status: DbProbeStatus;
  identity: DatabaseIdentity | null;
  preview: DbPreview;
  detail?: string;
}

/** One physical database (or one unidentifiable path) with every source that points at it kept as evidence. */
export interface DbSourceGroup {
  id: string;
  candidates: ResolvedCandidate[];
  kinds: DbSourceKind[];
  /** `conflict` when another group shares this lineage; otherwise the probe status. */
  status: DbGroupStatus;
  /** The probe status regardless of conflict. */
  probeStatus: DbProbeStatus;
  identity: DatabaseIdentity | null;
  preview: DbPreview;
  absolutePath: string;
  /** What kind of storage the file is on (DT-08); absent when it was not classified. */
  storageRisk?: StorageRiskResult;
}

export type UseReason = "desktop-committed" | "explicit-selection" | "consistent-legacy" | "default";

export type DbSourceDecision =
  | { kind: "use"; group: DbSourceGroup; reason: UseReason }
  | {
      kind: "needs-user-choice";
      groups: DbSourceGroup[];
      reason: "multiple-distinct" | "conflict" | "unverifiable" | "risky-storage";
    }
  | {
      kind: "blocked";
      reason: "selected-source-unavailable";
      status: Exclude<DbProbeStatus, "ok">;
      group: DbSourceGroup;
      source: DbSourceKind;
    }
  | { kind: "offer-new-database"; path: string; requiresExplicitConsent: true };

export interface DbSourceResolution {
  candidates: ResolvedCandidate[];
  groups: DbSourceGroup[];
  decision: DbSourceDecision;
}

import type { StorageRiskResult } from "./storage-risk.js";

export interface DatabaseIdentity {
  realPath: string;
  fileId: { device: string; inode: string } | null;
  lineageId: string | null;
}

export type DbSourceKind =
  | "desktop-committed"
  | "explicit-selection"
  | "legacy-service"
  | "plugin-link"
  | "agent-mcp"
  | "standalone-default"
  | "checkout-default";

export type DbProbeStatus = "missing" | "offline" | "denied" | "unreadable" | "unsupported-schema" | "ok";

export type DbGroupStatus = DbProbeStatus | "conflict";

export interface DbProbeResult {
  status: DbProbeStatus;
  identity?: DatabaseIdentity;
  schemaVersion?: number;
  projectCount?: number;
  detail?: string;
}

/** Read-only. A probe on synchronous SQLite (`node:sqlite` `DatabaseSync`) must run off the Electron main thread. */
export type DbProbe = (absolutePath: string) => Promise<DbProbeResult>;

export interface DbCandidate {
  kind: DbSourceKind;
  rawValue: string;
  resolutionBase: string;
  absolutePath: string;
  managedByCurrentUser: boolean | "unknown";
  invalidReason?: string;
}

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

export interface DbSourceGroup {
  id: string;
  candidates: ResolvedCandidate[];
  kinds: DbSourceKind[];
  status: DbGroupStatus;
  probeStatus: DbProbeStatus;
  identity: DatabaseIdentity | null;
  preview: DbPreview;
  absolutePath: string;
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
